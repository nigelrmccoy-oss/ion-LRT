/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Cesium Ion token — only from gitignored .env.local; never commit. */
  readonly VITE_CESIUM_ION_TOKEN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
