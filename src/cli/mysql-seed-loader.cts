/** Native file-URL imports for trusted modules, including the CommonJS CLI. */
async function importSeedModule(url: string): Promise<unknown> {
  try {
    return await import(url);
  } catch (error) {
    // CommonJS tsc lowers import(url) to require(url), which cannot resolve a
    // file URL. Delegate only that failure to this file's NodeNext-built copy,
    // where dynamic import survives. That copy has no sibling and cannot loop.
    if ((error as { code?: string })?.code !== 'MODULE_NOT_FOUND') throw error;
    let native: typeof importSeedModule | undefined;
    try {
      native = require('../../cli/mysql-seed-loader.cjs') as typeof importSeedModule;
    } catch {
      // Running source or the NodeNext copy: preserve the original failure.
    }
    if (!native) throw error;
    return native(url);
  }
}

export = importSeedModule;
