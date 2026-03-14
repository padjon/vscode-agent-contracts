export async function run(): Promise<void> {
  const suite = await import("./extension.integration.test");
  await suite.run();
}
