import { createApp } from '../app/handler.js';
import { loadConfig } from '../app/core.js';

let cachedApp;
let cachedEnv;

function getApp(env) {
  if (!cachedApp || cachedEnv !== env) {
    cachedEnv = env;
    cachedApp = createApp({
      config: loadConfig(env, {
        onWarn: (message) => console.warn(`[bridge] warn  ${message}`),
      }),
    });
  }
  return cachedApp;
}

export default {
  fetch(request, env) {
    return getApp(env)(request, {
      clientIp: request.headers.get('CF-Connecting-IP') || '',
    });
  },
};
