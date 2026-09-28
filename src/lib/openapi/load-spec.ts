import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';
import {
  HTTP_METHODS,
  type HttpMethod,
  type SpecDocument,
  type SpecOperation,
  type SpecResponseBody,
  type SpecSchema,
} from './types';

// load-spec: parse + validate openapi.yaml (the hand-maintained source of truth
// for /api/partner/v1). Fails LOUD on any shape it does not understand, so the
// drift test and the API reference page never silently skip an operation.
// js-yaml v4 `load` uses DEFAULT_SCHEMA (no JS-specific types):
// node_modules/js-yaml/README.md:70-89.

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || v.trim() === '') throw new Error(`openapi: ${what} must be a non-empty string`);
  return v;
};
const PARAM_IN = ['path', 'query', 'header'] as const;

const optStr = (v: unknown): string => (typeof v === 'string' ? v : '');

/** '#/components/<kind>/<Name>' → the named entry of components[kind]; throws when it is absent. */
function resolveRef(components: Obj, ref: unknown, kind: 'schemas' | 'responses', where: string): { name: string; target: Obj } {
  const prefix = `#/components/${kind}/`;
  if (typeof ref !== 'string' || !ref.startsWith(prefix)) throw new Error(`openapi: ${where} $ref ${String(ref)} is not a ${prefix} reference`);
  const name = ref.slice(prefix.length);
  const pool = components[kind];
  const target = isObj(pool) && Object.hasOwn(pool, name) ? pool[name] : undefined;
  if (!isObj(target)) throw new Error(`openapi: ${where} $ref ${ref} does not resolve`);
  return { name, target };
}

function responseBody(components: Obj, r: Obj, where: string): SpecResponseBody {
  const resolved = r.$ref === undefined ? r : resolveRef(components, r.$ref, 'responses', where).target;
  const content = resolved.content;
  if (content === undefined) return { schema: null, example: null, contentTypes: [] };
  if (!isObj(content)) throw new Error(`openapi: ${where} content is not an object`);
  const json = content['application/json'];
  let schema: string | null = null;
  let example: unknown = null;
  if (isObj(json)) {
    if (isObj(json.schema) && json.schema.$ref !== undefined) schema = resolveRef(components, json.schema.$ref, 'schemas', where).name;
    if ('example' in json) example = json.example;
  }
  return { schema, example, contentTypes: Object.keys(content) };
}

function parseSchemas(components: Obj): SpecSchema[] {
  const schemas = components.schemas;
  if (schemas === undefined) return [];
  if (!isObj(schemas)) throw new Error('openapi: components.schemas is not an object');
  return Object.entries(schemas).map(([name, raw]) => {
    if (!isObj(raw) || !isObj(raw.properties)) throw new Error(`openapi: schema ${name} must be an object with properties`);
    const required = Array.isArray(raw.required) ? raw.required : [];
    return {
      name,
      fields: Object.entries(raw.properties).map(([field, p]) => {
        const where = `schema ${name}.${field}`;
        if (!isObj(p)) throw new Error(`openapi: ${where} is not an object`);
        const t = p.type;
        const type = typeof t === 'string' ? t : Array.isArray(t) && t.length > 0 && t.every((x) => typeof x === 'string') ? t.join(' | ') : null;
        if (type === null) throw new Error(`openapi: ${where} type must be a string or a list of strings`);
        return { name: field, type, format: typeof p.format === 'string' ? p.format : null, required: required.includes(field), description: optStr(p.description) };
      }),
    };
  });
}

export function parseOpenApiDocument(text: string): SpecDocument {
  const doc = load(text);
  if (!isObj(doc) || typeof doc.openapi !== 'string' || !doc.openapi.startsWith('3.')) {
    throw new Error('openapi: not an OpenAPI 3.x document');
  }
  if (!isObj(doc.paths)) throw new Error('openapi: paths missing');
  const info = isObj(doc.info) ? doc.info : {};
  const server = Array.isArray(doc.servers) && isObj(doc.servers[0]) ? doc.servers[0] : {};
  const components = isObj(doc.components) ? doc.components : {};
  const tags = (Array.isArray(doc.tags) ? doc.tags : []).map((t) => {
    if (!isObj(t)) throw new Error('openapi: a top-level tag is not an object');
    return { name: str(t.name, 'tag name'), description: optStr(t.description) };
  });
  const ops: SpecOperation[] = [];
  const seenIds = new Set<string>();
  for (const [path, item] of Object.entries(doc.paths)) {
    if (!isObj(item)) throw new Error(`openapi: path ${path} is not an object`);
    for (const [k, raw] of Object.entries(item)) {
      const method = k.toUpperCase() as HttpMethod;
      if (!HTTP_METHODS.includes(method)) {
        if (k === 'parameters' || k === 'summary' || k === 'description') continue;
        throw new Error(`openapi: unknown key ${k} under ${path}`);
      }
      if (!isObj(raw)) throw new Error(`openapi: ${method} ${path} is not an object`);
      const where = `${method} ${path}`;
      const operationId = str(raw.operationId, `${where} operationId`);
      if (seenIds.has(operationId)) throw new Error(`openapi: duplicate operationId ${operationId}`);
      seenIds.add(operationId);
      const scope = str(raw['x-smartremit-scope'], `${where} x-smartremit-scope`);
      const sandbox = raw['x-smartremit-sandbox'];
      if (typeof sandbox !== 'boolean') {
        throw new Error(`openapi: ${where} x-smartremit-sandbox must be a boolean`);
      }
      if (!isObj(raw.responses)) throw new Error(`openapi: ${where} responses missing`);
      const responses: Record<number, string> = {};
      const responseBodies: Record<number, SpecResponseBody> = {};
      for (const [code, r] of Object.entries(raw.responses)) {
        if (!/^\d{3}$/.test(code)) throw new Error(`openapi: ${where} response key ${code} must be a 3-digit status`);
        if (!isObj(r)) throw new Error(`openapi: ${where} response ${code} is not an object`);
        responses[Number(code)] = str(r.description, `${where} response ${code} description`);
        responseBodies[Number(code)] = responseBody(components, r, `${where} response ${code}`);
      }
      const tags = Array.isArray(raw.tags) ? raw.tags : [];
      const params = raw.parameters === undefined ? [] : raw.parameters;
      if (!Array.isArray(params)) throw new Error(`openapi: ${where} parameters must be a list`);
      const body = isObj(raw.requestBody) && isObj(raw.requestBody.content)
        ? raw.requestBody.content['application/json'] : undefined;
      ops.push({
        path, method, operationId,
        summary: str(raw.summary, `${where} summary`),
        description: typeof raw.description === 'string' ? raw.description : '',
        tag: str(tags[0], `${where} tags[0]`),
        scope,
        sandbox,
        statuses: Object.keys(responses).map(Number).sort((a, b) => a - b),
        responses,
        parameters: params.map((p) => {
          if (!isObj(p)) throw new Error(`openapi: ${where} parameter is not an object`);
          const name = str(p.name, `${where} parameter name`);
          const loc = p.in;
          if (!PARAM_IN.includes(loc as (typeof PARAM_IN)[number])) {
            throw new Error(`openapi: ${where} parameter ${name} 'in' must be one of ${PARAM_IN.join(', ')}`);
          }
          return {
            name,
            in: loc as (typeof PARAM_IN)[number],
            required: p.required === true,
            description: typeof p.description === 'string' ? p.description : '',
          };
        }),
        requestExample: isObj(body) && 'example' in body ? body.example : null,
        requestBodyRequired: isObj(raw.requestBody) && raw.requestBody.required === true,
        responseBodies,
      });
    }
  }
  return {
    title: optStr(info.title),
    description: optStr(info.description).trim(),
    serverUrl: optStr(server.url),
    tags,
    schemas: parseSchemas(components),
    operations: ops,
  };
}

export function parseOpenApi(text: string): SpecOperation[] {
  return parseOpenApiDocument(text).operations;
}

/** The repo's openapi.yaml. process.cwd() is the repo root under vitest and `next build`. */
export function loadPartnerOpenApi(repoRoot: string = process.cwd()): SpecOperation[] {
  return parseOpenApi(readFileSync(join(repoRoot, 'openapi.yaml'), 'utf8'));
}

/** The whole repo openapi.yaml (server, tags, schemas, operations) for the API reference. */
export function loadPartnerOpenApiDocument(repoRoot: string = process.cwd()): SpecDocument {
  return parseOpenApiDocument(readFileSync(join(repoRoot, 'openapi.yaml'), 'utf8'));
}
