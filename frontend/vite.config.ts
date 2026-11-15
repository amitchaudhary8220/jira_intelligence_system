import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// In dev (npm run dev, port 5173) the React app forwards /api/* to FastAPI on port 8010.
// In production FastAPI serves the built files from frontend/dist, so there's one server.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { '/api': 'http://127.0.0.1:8010' },
  },
})
