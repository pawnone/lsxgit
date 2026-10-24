// No Space is opened, claimed or changed by this environment probe.
const names=['taskSpace','listTaskSpaces','claimTaskSpace','takeOverTaskSpace'];
const missing=names.filter(name=>typeof globalThis[name]!=='function');
console.log('WQ_EGO_PROBE '+JSON.stringify({ok:missing.length===0,missing}));
