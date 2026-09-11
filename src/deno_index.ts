// Legacy compatibility shim. Deno Deploy is not a supported deployment target.
import { handleRequest } from "./handle_request.js";

async function denoHandleRequest(req: Request): Promise<Response> {
  return handleRequest(req, Deno.env.toObject());
};

Deno.serve({ port: 80 },denoHandleRequest);
