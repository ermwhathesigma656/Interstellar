self.__scramjet$config = {
  prefix: "/uv/scramjet/",
  codec: {
    encode: url => url && encodeURIComponent(url).replace(/[!'()*]/g, char => "%" + char.charCodeAt(0).toString(16)),
    decode: url => url && decodeURIComponent(url),
  },
  files: {
    wasm: "/assets/scramjet/scramjet.wasm.wasm",
    all: "/assets/scramjet/scramjet.all.js",
    sync: "/assets/scramjet/scramjet.sync.js",
  },
  flags: {
    rewriterLogs: false,
    scramitize: false,
    cleanErrors: true,
    sourcemaps: true,
  },
};
