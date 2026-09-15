import { serve } from '@hono/node-server'
import app from './src/index.js'

const port = Number(process.env.PORT || 3000)

console.log(`Servidor iniciando na porta ${port}`)

serve({
  fetch: app.fetch,
  port
})
