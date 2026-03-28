const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function applyCors(headers) {
  Object.entries(corsHeaders).forEach(([key, value]) => {
    headers.set(key, value);
  });
  return headers;
}

function withCors(response) {
  applyCors(response.headers);
  return response;
}

export { corsHeaders, applyCors, withCors };
