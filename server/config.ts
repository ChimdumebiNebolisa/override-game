export const port = Number(process.env.PORT ?? 8787);

export const publicOrigin = new URL(process.env.PUBLIC_ORIGIN ??
  (process.env.NODE_ENV === 'production' ? `http://localhost:${port}` : 'http://localhost:5173')).origin;
