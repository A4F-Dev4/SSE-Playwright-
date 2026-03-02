import express from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import Anthropic from "@anthropic-ai/sdk";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "10mb" }));
app.use(express.static(join(__dirname, "public")));

app.get("/api/health", (_req, res) => res.json({ ok: true }));

// ─── OpenAI-compatible helper ─────────────────────────────────
async function callOpenAI(apiKey, baseURL, model, systemPrompt, tools, messages) {
  const openaiMessages = [
    { role: "system", content: systemPrompt },
    ...messages.map((m) => {
      if (m.role === "user" && Array.isArray(m.content)) {
        // tool results
        return m.content.map((tr) => ({
          role: "tool",
          tool_call_id: tr.tool_use_id,
          content: tr.content,
        }));
      }
      if (m.role === "assistant" && Array.isArray(m.content)) {
        const text = m.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
        const toolCalls = m.content.filter((b) => b.type === "tool_use").map((b) => ({
          id: b.id,
          type: "function",
          function: { name: b.name, arguments: JSON.stringify(b.input) },
        }));
        return {
          role: "assistant",
          content: text || null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        };
      }
      return m;
    }),
  ].flat();

  const openaiTools = tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));

  const resp = await fetch(`${baseURL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: openaiMessages,
      tools: openaiTools,
      max_tokens: 4096,
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`OpenAI API error ${resp.status}: ${err}`);
  }

  const data = await resp.json();
  const choice = data.choices[0];
  const msg = choice.message;

  // Convert to Anthropic-like format
  const content = [];
  if (msg.content) content.push({ type: "text", text: msg.content });
  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      content.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function.name,
        input: JSON.parse(tc.function.arguments),
      });
    }
  }

  return {
    content,
    stop_reason: msg.tool_calls ? "tool_use" : "end_turn",
  };
}

// ─── Anthropic helper ─────────────────────────────────────────
async function callAnthropic(apiKey, model, systemPrompt, tools, messages) {
  const claude = new Anthropic({ apiKey });
  return await claude.messages.create({
    model,
    max_tokens: 4096,
    system: systemPrompt,
    tools,
    messages,
  });
}

// ─── Main endpoint ────────────────────────────────────────────
app.post("/api/automate", async (req, res) => {
  const { url, instructions, apiKey, provider } = req.body;

  if (!url || !instructions || !apiKey) {
    return res.status(400).json({ error: "Faltan campos requeridos" });
  }

  // SSE
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();

  const send = (type, data) => {
    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  };

  const keepalive = setInterval(() => res.write(`: ping\n\n`), 15000);
  let mcpClient = null;

  try {
    // ─── 1. Playwright MCP ────────────────────────────────────
    send("status", { message: "Iniciando navegador Playwright..." });
    console.log(`\n📋 Nueva tarea: ${url} [${provider}]`);

    const transport = new StdioClientTransport({
      command: "npx",
      args: ["@playwright/mcp@latest", "--headless"],
    });

    mcpClient = new Client({ name: "form-filler", version: "1.0.0" });

    await Promise.race([
      mcpClient.connect(transport),
      new Promise((_, rej) => setTimeout(() => rej(new Error("Timeout: Playwright no respondió en 60s")), 60000)),
    ]);

    send("status", { message: "✅ Navegador conectado" });

    const { tools: mcpTools } = await mcpClient.listTools();
    send("status", { message: `🔧 ${mcpTools.length} herramientas listas` });

    const anthropicTools = mcpTools.map((t) => ({
      name: t.name,
      description: t.description || "",
      input_schema: t.inputSchema,
    }));

    // ─── 2. Validate key ──────────────────────────────────────
    send("status", { message: `Verificando API Key (${provider})...` });

    const systemPrompt = `Eres un experto en automatización web con Playwright.
Navega a la URL y completa el formulario según las instrucciones.

Estrategia:
1. browser_navigate -> ir a la URL
2. browser_snapshot -> ver la página
3. Llenar campos: browser_type (texto), browser_click (botones/checks), browser_select_option (dropdowns)
4. Enviar formulario
5. browser_snapshot -> confirmar resultado

IMPORTANTE: Después de cada acción importante, usa browser_take_screenshot para capturar una imagen de la página.

Reglas:
- Snapshot antes/después de acciones importantes
- Screenshot después de cada paso visual importante
- Si falla, intenta alternativa
- Reporta cada paso breve en español
- Confirma si fue exitoso al final`;

    // Choose provider
    let callLLM;
    if (provider === "openai") {
      callLLM = (msgs) => callOpenAI(apiKey, "https://api.openai.com/v1", "gpt-4o", systemPrompt, anthropicTools, msgs);
    } else if (provider === "groq") {
      callLLM = (msgs) => callOpenAI(apiKey, "https://api.groq.com/openai/v1", "llama-3.3-70b-versatile", systemPrompt, anthropicTools, msgs);
    } else {
      callLLM = (msgs) => callAnthropic(apiKey, "claude-haiku-4-5-20251001", systemPrompt, anthropicTools, msgs);
    }

    // Quick test
    try {
      await callLLM([{ role: "user", content: "ping" }]);
    } catch (e) {
      throw new Error("API Key inválida: " + e.message);
    }
    send("status", { message: "✅ API Key válida" });

    // ─── 3. Agentic loop ─────────────────────────────────────
    const MAX = 30;
    let messages = [
      { role: "user", content: `URL: ${url}\n\nInstrucciones: ${instructions}` },
    ];
    send("start", { url, instructions });

    for (let i = 0; i < MAX; i++) {
      send("iteration", { step: i + 1, max: MAX });
      console.log(`   ── Paso ${i + 1}/${MAX} ──`);

      let response;
      try {
        response = await callLLM(messages);
      } catch (e) {
        throw new Error("Error LLM: " + e.message);
      }

      for (const b of response.content) {
        if (b.type === "text" && b.text.trim()) {
          send("claude", { message: b.text });
          console.log(`   🤖 ${b.text.substring(0, 80)}`);
        }
      }

      if (response.stop_reason === "end_turn") {
        send("done", { message: "✅ ¡Formulario completado!" });
        break;
      }

      messages.push({ role: "assistant", content: response.content });
      const toolCalls = response.content.filter((b) => b.type === "tool_use");

      if (toolCalls.length === 0) {
        send("done", { message: "✅ Completado." });
        break;
      }

      const toolResults = [];
      for (const call of toolCalls) {
        send("tool_call", {
          name: call.name,
          args: JSON.stringify(call.input).substring(0, 100),
        });
        console.log(`   🔧 ${call.name}`);

        try {
          const result = await mcpClient.callTool({
            name: call.name,
            arguments: call.input,
          });

          const textParts = [];
          let screenshotData = null;

          for (const c of result.content) {
            if (c.type === "text") {
              textParts.push(c.text);
            } else if (c.type === "image" || (c.type === "resource" && c.resource?.mimeType?.startsWith("image"))) {
              // Capture screenshot data
              const imgData = c.data || c.resource?.blob;
              if (imgData) screenshotData = imgData;
            } else {
              textParts.push(JSON.stringify(c));
              // Check for base64 image in stringified content
              if (c.data && typeof c.data === "string" && c.data.length > 500) {
                screenshotData = c.data;
              }
            }
          }

          const text = textParts.join("\n");
          const fullContent = result.content.map((c) =>
            c.type === "text" ? c.text : JSON.stringify(c)
          ).join("\n");

          send("tool_result", {
            name: call.name,
            result: text.length > 200 ? text.substring(0, 200) + "..." : text,
          });

          // Send screenshot to frontend if found
          if (screenshotData) {
            send("screenshot", { data: screenshotData });
          }

          // Also check if the tool is a screenshot tool
          if (call.name.includes("screenshot")) {
            // Try to extract base64 from result
            for (const c of result.content) {
              if (c.data) {
                send("screenshot", { data: c.data });
                break;
              }
              const str = JSON.stringify(c);
              const match = str.match(/"data"\s*:\s*"([A-Za-z0-9+/=]{100,})"/);
              if (match) {
                send("screenshot", { data: match[1] });
                break;
              }
            }
          }

          toolResults.push({
            type: "tool_result",
            tool_use_id: call.id,
            content: fullContent,
          });
        } catch (err) {
          send("tool_error", { name: call.name, error: err.message });
          toolResults.push({
            type: "tool_result",
            tool_use_id: call.id,
            content: "Error: " + err.message,
            is_error: true,
          });
        }
      }
      messages.push({ role: "user", content: toolResults });
    }
  } catch (err) {
    send("error", { message: err.message });
    console.error("   ❌", err.message);
  } finally {
    clearInterval(keepalive);
    if (mcpClient) {
      try { await mcpClient.close(); } catch (_) {}
    }
    send("end", {});
    res.end();
  }
});

app.listen(PORT, () => {
  console.log(`\n🤖 Form Filler listo en http://localhost:${PORT}\n`);
});
