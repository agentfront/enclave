import { CreateSessionRequestSchema } from '@enclave-vm/types';
import type { CreateSessionRequest } from '@enclave-vm/types';
import { parseCreateSessionRequest } from './request-validation';

describe('parseCreateSessionRequest', () => {
  const documentedBodies: CreateSessionRequest[] = [
    { code: 'return 1;' },
    {
      code: 'return 1;',
      sessionId: 's_3f0e2f6e-1c1b-4c57-9a55-0a8b5a3d2c11',
      config: { maxExecutionMs: 30_000, maxToolCalls: 10, heartbeatIntervalMs: 15_000 },
    },
    {
      code: 'return 1;',
      filter: {
        mode: 'exclude',
        rules: [
          { types: { types: ['heartbeat'] } },
          { content: { patterns: [{ type: 'glob', pattern: 'debug*', field: 'payload.message' }], match: 'all' } },
        ],
      },
    },
  ];

  it.each(documentedBodies)('reads a body of the shared schema as the schema does (%#)', (body) => {
    const schemaResult = CreateSessionRequestSchema.safeParse(body);

    expect(schemaResult.success).toBe(true);
    expect(parseCreateSessionRequest(body)).toMatchObject({ ok: true, value: schemaResult.data });
  });

  it('refuses a body without code, as the shared schema does', () => {
    expect(CreateSessionRequestSchema.safeParse({ sessionId: 's_abc' }).success).toBe(false);
    expect(parseCreateSessionRequest({ sessionId: 's_abc' }).ok).toBe(false);
  });
});
