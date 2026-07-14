import "vitest";

declare module "vitest" {
  interface ProvidedContext {
    addonPublicKeyPem: string;
    addonPrivateKeyPem: string;
  }
}
