// CORS + response helpers shared by every function.
//
// The demo page is served from localhost while the functions live on
// *.supabase.co, so every call is cross-origin and preflighted.

import { HttpError } from "./pco.ts";

export const corsHeaders = {
  "Access-Control-Allow-Origin": Deno.env.get("ALLOWED_ORIGIN") ?? "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/**
 * Wrap a handler with preflight handling and error-to-JSON mapping, so no
 * handler ever leaks a stack trace or answers a preflight with a 500.
 */
export function handler(fn: (req: Request) => Promise<Response>) {
  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") {
      return new Response("ok", { headers: corsHeaders });
    }
    try {
      return await fn(req);
    } catch (err) {
      if (err instanceof HttpError) {
        return json({ error: err.message }, err.status);
      }
      console.error(err);
      const message = err instanceof Error ? err.message : String(err);
      return json({ error: message }, 500);
    }
  };
}
