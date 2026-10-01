// sdk/test/teardown.test.ts
//
// snarkjs proves with a pool of worker threads, kept on globalThis.curve_bn128 and reused by every
// later proof. Nothing in the library closes it, so after the proof tests passed `npm test` never
// exited: mocha finished ("98 passing") and the process stayed up until killed. A hook declared
// outside any describe block is a root hook in mocha: it runs once, after every test in every file.
// The circuits suite does the same in its afterAll.

after(async () => {
  const curve = (globalThis as { curve_bn128?: { terminate: () => Promise<void> } }).curve_bn128;
  await curve?.terminate();
});
