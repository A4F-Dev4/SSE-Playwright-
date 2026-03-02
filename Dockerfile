FROM node:20-slim

# Playwright install --with-deps instala Chromium + TODAS las libs del sistema automáticamente
# Esto es más confiable que listar paquetes manualmente
RUN npx playwright install --with-deps chromium

WORKDIR /app

COPY package.json .
RUN npm install

COPY server.mjs .
COPY public/ public/

# Render inyecta PORT automáticamente
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.mjs"]
