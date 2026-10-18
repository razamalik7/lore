const origEmitWarning = process.emitWarning;
process.emitWarning = ((warning: any, ...args: any[]) => {
  if (typeof warning === 'string' && warning.includes('SQLite')) return;
  if (warning && typeof warning === 'object' && String(warning.message || '').includes('SQLite')) return;
  return (origEmitWarning as any).call(process, warning, ...args);
}) as typeof process.emitWarning;
