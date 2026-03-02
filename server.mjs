import express from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import Anthropic from "@anthropic-ai/sdk";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(join(__dirname, "public")));

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.post("/api/automate", async (req, res) => {
  const { url, instructions, apiKey, headless } = req.body;

  if (!url || !instructions || !apiKey) {
    return res.status(400).json({ error: "Faltan campos requeridos" });
  }

  // SSE setup
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
    // ─── 1. Start Playwright MCP ──────────────────────────────
    send("status", { message: "Iniciando navegador Playwright..." });
    console.log(`\n📋 Nueva tarea: ${url}`);

    const transport = new StdioClientTransport({
      command: "npx",
      args: ["@playwright/mcp@latest", "--headless"],
    });

    mcpClient = new Client({ name: "form-filler", version: "1.0.0" });

    await Promise.race([
      mcpClient.connect(transport),
      new Promise((_, rej) => setTimeout(() => rej(new Error(
        "Timeout: Playwright no respondió en 60s"
      )), 60000)),
    ]);

    send("status", { message: "✅ Navegador conectado" });
    console.log("   ✅ MCP conectado");

    // ─── 2. List tools ────────────────────────────────────────
    const { tools: mcpTools } = await mcpClient.listTools();
    send("status", { message: `🔧 ${mcpTools.length} herramientas listas` });

    const anthropicTools = mcpTools.map((t) => ({
      name: t.name,
      description: t.description || "",
      input_schema: t.inputSchema,
    }));

    // ─── 3. Validate API key ──────────────────────────────────
    send("status", { message: "Verificando API Key..." });
    const claude = new Anthropic({ apiKey });

    try {
      await claude.messages.create({
        model: "claude-haiku-4-5-20250929",
        max_tokens: 10,
        messages: [{ role: "user", content: "hi" }],
      });
    } catch (e) {
      throw new Error("API Key inválida: " + e.message);
    }
    send("status", { message: "✅ API Key válida" });

    // ─── 4. System prompt ─────────────────────────────────────
    const systemPrompt = `Eres un experto en automatización web con Playwright.
Navega a la URL y completa el formulario según las instrucciones.

Estrategia:
1. browser_navigate -> ir a la URL
2. browser_snapshot -> ver la página
3. Llenar campos: browser_type (texto), browser_click (botones/checks), browser_select_option (dropdowns)
4. Enviar formulario
5. browser_snapshot -> confirmar resultado

Reglas:
- Snapshot antes/después de acciones importantes
- Si falla, intenta alternativa
- Reporta cada paso breve en español
- Confirma si fue exitoso al final`;

    // ─── 5. Agentic loop ─────────────────────────────────────
    const MAX = 30;
    let messages = [
      { role: "user", content: `URL: ${url}\n\nInstrucciones: ${instructions}` },
    ];
    send("start", { url, instructions });

    for (let i = 0; i < MAX; i++) {
      send("iteration", { step: i + 1, max: MAX });

      const response = await claude.messages.create({
        model: "claude-haiku-4-5-20250929",
        max_tokens: 4096,
        system: systemPrompt,
        tools: anthropicTools,
        messages,
      });

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
          const text = result.content
            .map((c) => (c.type === "text" ? c.text : JSON.stringify(c)))
            .join("\n");

          send("tool_result", {
            name: call.name,
            result: text.length > 200 ? text.substring(0, 200) + "..." : text,
          });

          toolResults.push({
            type: "tool_result",
            tool_use_id: call.id,
            content: text,
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
