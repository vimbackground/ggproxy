  import { handleRequest } from "./handle_request.js";

  export default {
    async fetch (req, env, context) {
      return handleRequest(req, env);
    }
  }
