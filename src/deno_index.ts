import { handleRequest } from "./handle_request.js";

async function denoHandleRequest(req: Request): Promise<Response> {
  return handleRequest(req, Deno.env.toObject());
};

Deno.serve({ port: 80 },denoHandleRequest);
