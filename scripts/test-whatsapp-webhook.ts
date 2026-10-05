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

console.log('test-whatsapp-webhook: all asserts passed');
