# 🎭 Playwright Form Filler

Automatiza formularios web con Claude Haiku + Playwright MCP.

## Deploy en Railway (1 click)

1. Sube este proyecto a un repo de GitHub
2. Ve a [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub**
3. Selecciona el repo → Railway detecta el Dockerfile automáticamente
4. Espera ~3 min a que haga build (instala Chromium)
5. Railway te da una URL pública → ¡listo!

> No necesitas configurar variables de entorno en Railway.
> La API Key de Anthropic se ingresa desde la interfaz web.

## Deploy en Render

1. Sube a GitHub
2. Ve a [render.com](https://render.com) → New → **Web Service**
3. Conecta el repo
4. Environment: **Docker**
5. Deploy → te da URL pública

## Uso local

```bash
npm install
npx playwright install chromium
npm start
# → http://localhost:3000
```

## Estructura

```
├── Dockerfile          # Build con Chromium incluido
├── railway.json        # Config Railway
├── package.json
├── server.mjs          # Express + SSE + loop agéntico
└── public/
    └── index.html      # Interfaz web
```

## Cómo funciona

```
Browser → Express (SSE) → Claude Haiku API ⇄ Playwright MCP → Chromium
```

Claude recibe herramientas del navegador (click, type, snapshot, etc),
decide qué hacer, y ejecuta cada acción en un Chromium real headless.
Los logs se transmiten en tiempo real al frontend.
