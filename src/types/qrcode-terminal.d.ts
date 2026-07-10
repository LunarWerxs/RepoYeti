declare module "qrcode-terminal" {
  export function generate(
    text: string,
    options?: { small?: boolean },
    callback?: (qr: string) => void,
  ): void;
  const _default: { generate: typeof generate };
  export default _default;
}
