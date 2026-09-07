// Declaraciones de tipos globales para Deno y Supabase Edge Functions en el editor
declare namespace Deno {
  export const env: {
    get(key: string): string | undefined;
    set(key: string, value: string): void;
    delete(key: string): void;
  };
}

declare namespace EdgeRuntime {
  export function waitUntil(promise: Promise<unknown>): void;
}

declare module "https://*" {
  const content: any;
  export default content;
  export const serve: any;
  export const createClient: any;
  export const delay: any;
}
