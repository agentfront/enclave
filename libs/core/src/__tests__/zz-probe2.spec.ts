import { Enclave } from '../enclave';
import { createSafeReflect } from '../secure-proxy';

const POC = `
const o = {};
const { "constructor": IO } = o;
const { "prototype": pr } = callTool;
const pp = IO.getPrototypeOf(pr);
const { "constructor": PO } = pp;
const p = callTool("getUser", { id: 1 });
const orig = PO.getOwnPropertyDescriptor;
let captured = null;
const hook = (t, k) => { if (captured === null) { captured = t; } return orig(t, k); };
PO.defineProperty(PO, "getOwnPropertyDescriptor", { value: hook, writable: true, configurable: true });
const trigger = p.zzz;
return 'done';
`;

it('probe codes', async () => {
  const cases: Array<[string, any, string]> = [
    ['poc-validate-on', {}, POC],
    ['poc-validate-off', { validate: false }, POC],
    ['poc-single-vm', { doubleVm: { enabled: false } }, POC],
    ['gadget-gopd', {}, `return Object.getOwnPropertyDescriptor({}, 'x');`],
    ['gadget-defprop', {}, `return Object.defineProperty({}, 'x', { value: 1 });`],
    ['gadget-setproto', {}, `return Object.setPrototypeOf({}, null);`],
  ];
  for (const [name, opts, code] of cases) {
    const e = new Enclave({ toolHandler: async () => ({ id: 1, name: 'x' }), ...opts });
    const r = await e.run(code);
    // eslint-disable-next-line no-console
    console.log(
      name,
      '=>',
      JSON.stringify({ success: r.success, code: r.error?.code, msg: r.error?.message?.slice(0, 90) }),
    );
    e.dispose();
  }
}, 120000);

it('probe safeReflect mutability + construct', () => {
  const sr = createSafeReflect('STANDARD') as any;
  const before = Reflect.get;
  try {
    sr.get = function tampered() {
      return 'X';
    };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.log('assignment threw:', (err as Error).message.slice(0, 80));
  }
  // eslint-disable-next-line no-console
  console.log('host Reflect.get mutated?', Reflect.get !== before);
  Reflect.get = before;

  const beforeSet = Reflect.set;
  try {
    Object.defineProperty(sr, 'set', { value: () => 'Y', writable: true, configurable: true });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.log('defineProperty threw:', (err as Error).message.slice(0, 80));
  }
  // eslint-disable-next-line no-console
  console.log('host Reflect.set mutated?', Reflect.set !== beforeSet);
  Reflect.set = beforeSet;

  try {
    // eslint-disable-next-line no-console
    console.log('construct(Array,[3],undefined) =>', JSON.stringify(sr.construct(Array, [3], undefined)));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.log('construct(Array,[3],undefined) threw:', (err as Error).message.slice(0, 80));
  }
  // eslint-disable-next-line no-console
  console.log(
    'native Reflect.construct(Array,[3],undefined) =>',
    (() => {
      try {
        return JSON.stringify(Reflect.construct(Array, [3], undefined as any));
      } catch (e) {
        return 'THREW: ' + (e as Error).message.slice(0, 60);
      }
    })(),
  );
});
