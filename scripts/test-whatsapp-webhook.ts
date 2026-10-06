/**
 * WhatsApp Meta hub.verify_token handshake.
 * From server/:  npx ts-node --transpile-only scripts/test-whatsapp-webhook.ts
 */
import assert from 'assert';
import { createHmac } from 'crypto';
import { whatsappHubChallenge, whatsappSignatureOk } from '../src/whatsapp/whatsapp-verify';
import { canonicalWhatsappPhone, extractInboundMessages } from '../src/whatsapp/whatsapp-inbound';
import { decryptSettingsJson, encryptSettingsJson } from '../src/whatsapp/settings-crypto';
import { chatModelId, defaultGeminiModel, geminiModelScore, smoothReply } from '../src/whatsapp/gemini-client';
import { defaultGroqModel, groqModelScore } from '../src/whatsapp/groq-client';
import {
  closingReply,
  collectChatFacts,
  conversationClosed,
  isSideQuestion,
  nextMissingField,
  parseChatFacts,
  recapFacts,
  scriptedNavyaReply,
} from '../src/whatsapp/whatsapp-facts';

const expected = 'az_wa_test_token_value';

assert.strictEqual(
  whatsappHubChallenge({
    mode: 'subscribe',
    token: expected,
    challenge: '1234567890',
    expectedToken: expected,
  }),
  '1234567890',
);

assert.strictEqual(
  whatsappHubChallenge({
    mode: 'subscribe',
    token: 'wrong',
    challenge: '123',
    expectedToken: expected,
  }),
  null,
);

assert.strictEqual(
  whatsappHubChallenge({
    mode: 'unsubscribe',
    token: expected,
    challenge: '123',
    expectedToken: expected,
  }),
  null,
);

assert.strictEqual(
  whatsappHubChallenge({
    mode: 'subscribe',
    token: expected,
    challenge: '123',
    expectedToken: '',
  }),
  null,
);

const body = Buffer.from('{"object":"whatsapp_business_account"}');
const secret = 'test_app_secret';
const goodSig = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
assert.strictEqual(whatsappSignatureOk(body, goodSig, secret), true);
assert.strictEqual(whatsappSignatureOk(body, goodSig, 'other'), false);
assert.strictEqual(whatsappSignatureOk(body, undefined, ''), true);
assert.strictEqual(whatsappSignatureOk(body, 'sha256=abcd', secret), false);

const inbound = extractInboundMessages({
  object: 'whatsapp_business_account',
  entry: [
    {
      changes: [
        {
          value: {
            contacts: [{ profile: { name: 'Riya' }, wa_id: '919876543210' }],
            messages: [
              {
                from: '919876543210',
                id: 'wamid.1',
                type: 'text',
                text: { body: 'Hello' },
              },
            ],
          },
        },
      ],
    },
  ],
});
assert.strictEqual(inbound.length, 1);
assert.strictEqual(inbound[0].phone, '919876543210');
assert.strictEqual(canonicalWhatsappPhone('9876543210'), '919876543210');
assert.strictEqual(canonicalWhatsappPhone('+91 98765 43210'), '919876543210');
assert.strictEqual(canonicalWhatsappPhone('919876543210'), '919876543210');
assert.strictEqual(inbound[0].text, 'Hello');
assert.strictEqual(inbound[0].profileName, 'Riya');
assert.strictEqual(inbound[0].phoneNumberId, '');
assert.deepStrictEqual(extractInboundMessages({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: { statuses: [{ id: '1' }] } }] }] }), []);

const sealed = encryptSettingsJson({ accessToken: 'secret-token' });
assert.notStrictEqual(sealed, 'secret-token');
assert.deepStrictEqual(decryptSettingsJson(sealed), { accessToken: 'secret-token' });
assert.strictEqual(decryptSettingsJson('nope'), null);

assert.strictEqual(defaultGeminiModel([]), '');
assert.strictEqual(defaultGeminiModel(['gemini-2.5-flash', 'gemini-2.5-pro']), 'gemini-2.5-flash');
assert.ok(geminiModelScore('gemini-2.5-flash') > geminiModelScore('gemini-2.5-pro'));
assert.strictEqual(
  chatModelId({ name: 'models/gemini-embedding-001', supportedGenerationMethods: ['generateContent'] }),
  '',
);
assert.strictEqual(
  chatModelId({ name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] }),
  'gemini-2.5-flash',
);
assert.strictEqual(smoothReply('Namaste\n\n  Navya  \n'), 'Namaste\nNavya');
assert.ok(groqModelScore('openai/gpt-oss-20b') > groqModelScore('openai/gpt-oss-120b'));
assert.ok(groqModelScore('whisper-large-v3') < 0);
assert.strictEqual(defaultGroqModel([]), 'openai/gpt-oss-20b');
assert.strictEqual(defaultGroqModel(['openai/gpt-oss-120b', 'openai/gpt-oss-20b']), 'openai/gpt-oss-20b');

const afterPincode = collectChatFacts(
  {},
  [
    { role: 'user', text: 'Hi' },
    { role: 'assistant', text: 'Pehle bataiye, aapko personal loan chahiye ya insurance?' },
    { role: 'user', text: 'Loan' },
    { role: 'assistant', text: 'Something went wrong. Please ek baar phir try karein.' },
    { role: 'user', text: 'Personal loan' },
    { role: 'assistant', text: 'Great! Pehle aapka poora naam bataiye.' },
    { role: 'user', text: 'Atul Kumar' },
    { role: 'assistant', text: 'Nice, Atul Kumar ji. Ab pincode ya shehar ka naam bataiye.' },
    { role: 'user', text: '221011' },
  ],
  'Er.Atul',
);
assert.strictEqual(afterPincode.product, 'personal_loan');
assert.strictEqual(afterPincode.name, 'Atul Kumar');
assert.strictEqual(afterPincode.pincode, '221011');
assert.strictEqual(nextMissingField(afterPincode), 'employment');
const nextReply = scriptedNavyaReply(afterPincode, 'Er.Atul') ?? '';
assert.ok(/salaried/i.test(nextReply));
assert.ok(!/income/i.test(nextReply));
assert.ok(!/loan amount|kitna loan/i.test(nextReply));
const first = scriptedNavyaReply({}, 'Er.Atul') ?? '';
assert.ok(/Navya/i.test(first));
assert.ok(/personal loan/i.test(first));
assert.ok(/insurance/i.test(first));

const complete = {
  product: 'personal_loan' as const,
  name: 'Atul Kumar',
  pincode: '221011',
  employment: 'salaried' as const,
  income: '30000',
  loanAmount: '200000',
  tenureMonths: '24',
  pan: 'ABCDE1234F',
};
assert.strictEqual(nextMissingField(complete), 'done');
const end = recapFacts(complete, 'Er.Atul');
assert.ok(/Thank you/i.test(end));
assert.ok(/wait kijiye/i.test(end));
assert.ok(!/\?/.test(end));
assert.ok(!/Navya/i.test(end));
assert.ok(!/ABCDE1234F/.test(end));
const afterClose = closingReply(complete, 'Er.Atul', true);
assert.ok(/already mil chuki/i.test(afterClose));
assert.ok(!/₹2,00,000/.test(afterClose));
assert.ok(
  conversationClosed([{ role: 'assistant', text: end }]),
);

const emiLine = 'Pele bta kitna emi rate h tumara lakh pe';
assert.ok(isSideQuestion(emiLine));
assert.ok(!parseChatFacts({ city: emiLine }).city);
const emiFacts = collectChatFacts(
  {},
  [
    { role: 'user', text: 'Hi' },
    { role: 'assistant', text: 'Pehle bataiye, aapko personal loan chahiye ya insurance?' },
    { role: 'user', text: 'Loan' },
    { role: 'assistant', text: 'Great! WhatsApp pe naam Gaurav Patel dikh raha hai. Yahi poora naam use karun, ya aap alag naam likh denge?' },
    { role: 'user', text: 'haan' },
    { role: 'assistant', text: 'Nice, Gaurav Patel ji. Ab pincode ya shehar ka naam bataiye.' },
    { role: 'user', text: emiLine },
  ],
  'Gaurav Patel',
);
assert.strictEqual(emiFacts.product, 'personal_loan');
assert.ok(!emiFacts.city);
assert.ok(!emiFacts.pincode);
assert.strictEqual(nextMissingField(emiFacts), 'pincode');
const cityFacts = collectChatFacts(
  emiFacts,
  [
    { role: 'assistant', text: 'Nice, Gaurav Patel ji. Ab pincode ya shehar ka naam bataiye.' },
    { role: 'user', text: 'Lucknow' },
  ],
  'Gaurav Patel',
);
assert.strictEqual(cityFacts.city, 'Lucknow');
assert.strictEqual(nextMissingField(cityFacts), 'employment');

console.log('test-whatsapp-webhook: all asserts passed');
