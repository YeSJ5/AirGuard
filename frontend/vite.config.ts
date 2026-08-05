import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
// @ts-ignore
import cesium from 'vite-plugin-cesium'

// https://vite.dev/config/
export default defineConfig({
  // @ts-ignore
  plugins: [react(), cesium()],
})
