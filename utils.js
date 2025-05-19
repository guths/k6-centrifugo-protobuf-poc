import crypto from "k6/crypto";
import encoding from "k6/encoding";

/**
 * Generates a JWT token
 */
export function generateJWT(payload, secret) {
  const header = encoding.b64encode(
    JSON.stringify({ typ: "JWT", alg: "HS256" }),
    "rawurl"
  );

  const encodedPayload = encoding.b64encode(JSON.stringify(payload), "rawurl");

  const signature = signHMAC(`${header}.${encodedPayload}`, secret);

  return `${header}.${encodedPayload}.${signature}`;
}

/**
 * Signs data with HMAC SHA-256
 */
export function signHMAC(data, secret) {
  const hasher = crypto.createHMAC("sha256", secret);
  hasher.update(data);
  return hasher
    .digest("base64")
    .replace(/\//g, "_")
    .replace(/\+/g, "-")
    .replace(/=/g, "");
}

/**
 * Parse multiple JSON objects from a single string
 */
// This function is necessary because the Centrifugo server sends multiple JSON objects in a single message.
// So to avoid parsing errors, we need to parse each JSON object separately.
export function parseMultipleJSONObjects(data) {
  const results = [];
  let buffer = "";
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = 0; i < data.length; i++) {
    const char = data[i];
    buffer += char;

    if (inString) {
      if (escape) {
        escape = false;
      } else if (char === "\\") {
        escape = true;
      } else if (char === '"') {
        inString = false;
      }
    } else {
      if (char === '"') {
        inString = true;
      } else if (char === "{") {
        depth++;
      } else if (char === "}") {
        depth--;
        if (depth === 0) {
          try {
            results.push(JSON.parse(buffer));
          } catch (e) {
            console.error("Parse error:", e, "Buffer:", buffer);
          }
          buffer = "";
        }
      }
    }
  }

  return results;
}
