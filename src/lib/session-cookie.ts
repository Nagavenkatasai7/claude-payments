// Isolated so middleware can import the cookie name without pulling in
// next/headers or the Redis client.
export const SESSION_COOKIE = 'sendhome_session';
