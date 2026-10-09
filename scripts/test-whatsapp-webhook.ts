/**
 * WhatsApp Meta hub.verify_token handshake.
 * From server/:  npx ts-node --transpile-only scripts/test-whatsapp-webhook.ts
 */
import assert from 'assert';
import { createHmac } from 'crypto';
import { isGraphTimeout } from '../src/whatsapp/whatsapp-graph';
import { whatsappHubChallenge, whatsappSignatureOk } from '../src/whatsapp/whatsapp-verify';
import { adminTargetPhone, canonicalWhatsappPhone, extractInboundMessages } from '../src/whatsapp/whatsapp-inbound';
import { decryptSettingsJson, encryptSettingsJson } from '../src/whatsapp/settings-crypto';
import { asChat } from '../src/whatsapp/whatsapp-chat';
import { kycBodyName, kycChatText, kycGraphPayload, kycProductName, KYC_START_BTN, KYC_TEMPLATE, KYC_TEMPLATE_LANG } from '../src/whatsapp/whatsapp-kyc';
import {
  alreadyAdminMessaged,
  alreadyKycDocsAsked,
  alreadyKycStarted,
  alreadyWelcomed,
  insuranceText,
  isKycStartClick,
  isKycStatusClick,
  kycDocsRequestText,
  personalLoanText,
  productChoice,
  statusCheckText,
  thankYouText,
  welcomeText,
} from '../src/whatsapp/whatsapp-templates';

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
assert.strictEqual(whatsappSignatureOk(body, undefined, ''), false);
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
assert.strictEqual(adminTargetPhone('9876543210'), '919876543210');
assert.strictEqual(adminTargetPhone('+91 98765 43210'), '919876543210');
assert.strictEqual(adminTargetPhone('12345'), null);
assert.strictEqual(adminTargetPhone('5876543210'), null);
assert.strictEqual(canonicalWhatsappPhone('+91 98765 43210'), '919876543210');
assert.strictEqual(canonicalWhatsappPhone('919876543210'), '919876543210');
assert.strictEqual(inbound[0].text, 'Hello');
assert.strictEqual(inbound[0].buttonId, '');
assert.strictEqual(inbound[0].profileName, 'Riya');
assert.strictEqual(inbound[0].phoneNumberId, '');
assert.deepStrictEqual(extractInboundMessages({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: { statuses: [{ id: '1' }] } }] }] }), []);

const sealed = encryptSettingsJson({ accessToken: 'secret-token' });
assert.notStrictEqual(sealed, 'secret-token');
assert.deepStrictEqual(decryptSettingsJson(sealed), { accessToken: 'secret-token' });
assert.strictEqual(decryptSettingsJson('nope'), null);

const click = extractInboundMessages({
  object: 'whatsapp_business_account',
  entry: [
    {
      changes: [
        {
          value: {
            contacts: [{ profile: { name: 'Gaurav' }, wa_id: '919876543210' }],
            messages: [
              {
                from: '919876543210',
                id: 'wamid.2',
                type: 'interactive',
                interactive: { button_reply: { id: 'personal_loan', title: 'Personal Loan' } },
              },
            ],
          },
        },
      ],
    },
  ],
});
assert.strictEqual(click[0].buttonId, 'personal_loan');
assert.strictEqual(productChoice(click[0].buttonId, click[0].text), 'personal_loan');
assert.strictEqual(productChoice('insurance', 'Insurance'), 'insurance');
assert.ok(/Personal Loan/.test(welcomeText('Gaurav')));
assert.ok(!/Navya/i.test(welcomeText('Gaurav')));
assert.ok(/apnizaroorat.com\/products\/personal-loan/.test(personalLoanText('Gaurav')));
assert.ok(/\n\nAapke liye/.test(personalLoanText('Gaurav')));
assert.ok(/\n\nAapke liye/.test(insuranceText('Gaurav')));
assert.ok(/apnizaroorat.com\/products\/insurance\//.test(insuranceText('Gaurav')));
assert.ok(/Health, Bike, Life/.test(insuranceText('Gaurav')));
assert.ok(!/50 Lakh/i.test(personalLoanText('Gaurav')));
assert.ok(alreadyWelcomed([{ role: 'assistant', kind: 'welcome', text: welcomeText('Gaurav') }]));
assert.ok(!alreadyWelcomed([{ role: 'user', text: 'Hi' }]));
assert.ok(/Thank you/.test(thankYouText('Gaurav')));
assert.ok(/jald hi contact/.test(thankYouText('Gaurav')));
assert.ok(/apnizaroorat.com\//.test(thankYouText('Gaurav')));

assert.strictEqual(kycBodyName('  Raju   Patel\n'), 'Raju Patel');
assert.strictEqual(kycProductName('personal_loan'), 'Personal Loan');
assert.strictEqual(kycProductName('insurance'), 'Insurance');
const kycPayload = kycGraphPayload('919876543210', 'Raju Patel', 'insurance', 'en_GB') as {
  template: { name: string; language: { code: string }; components: { parameters: { text: string }[] }[] };
};
assert.strictEqual(kycPayload.template.name, 'application_kyc');
assert.strictEqual(KYC_TEMPLATE, 'application_kyc');
assert.strictEqual(KYC_TEMPLATE_LANG, 'en_GB');
assert.strictEqual(kycPayload.template.language.code, KYC_TEMPLATE_LANG);
assert.strictEqual(kycPayload.template.components[0].parameters[0].text, 'Raju Patel');
assert.strictEqual(kycPayload.template.components[0].parameters[1].text, 'Insurance');
assert.ok(alreadyKycStarted([{ role: 'assistant', kind: 'kyc' }]));
assert.ok(!alreadyKycStarted([{ role: 'assistant', kind: 'welcome' }]));
assert.strictEqual(asChat({ messages: [{ id: 'kyc:1', role: 'assistant', kind: 'kyc', text: 'x' }] }).messages[0].kind, 'kyc');
const kycBtn = extractInboundMessages({
  object: 'whatsapp_business_account',
  entry: [
    {
      changes: [
        {
          value: {
            contacts: [{ profile: { name: 'Atul' }, wa_id: '919876543210' }],
            messages: [
              {
                from: '919876543210',
                id: 'wamid.kyc',
                type: 'button',
                button: { payload: 'Haan, KYC Start Karein', text: 'Haan, KYC Start Karein' },
              },
            ],
          },
        },
      ],
    },
  ],
});
assert.ok(isKycStartClick(kycBtn[0].buttonId, kycBtn[0].text));
assert.ok(isKycStartClick('Haan, KYC Start Karein', ''));
assert.ok(isKycStartClick('', 'Haan, KYC Start Karein'));
assert.ok(!isKycStartClick('Application Status Check Karein', ''));
assert.ok(isKycStatusClick('Application Status Check Karein', ''));
assert.ok(isKycStatusClick('', 'Application Status Check Karein'));
assert.ok(!isKycStatusClick('Haan, KYC Start Karein', ''));
assert.ok(!isKycStatusClick('Haan, KYC Start Karein', 'Application Status Check Karein'));
const statusText = statusCheckText();
assert.ok(/registered phone number/i.test(statusText));
assert.ok(/apnizaroorat.com\/customer\/login\//.test(statusText));
assert.ok(/click here/.test(statusText));
assert.ok(/📱/.test(statusText));
assert.ok(/👇/.test(statusText));
assert.ok(!/1️⃣/.test(statusText));
assert.ok(!/\.gif/i.test(statusText));
assert.strictEqual(asChat({ messages: [{ id: 'st:1', role: 'assistant', kind: 'status', text: 'x' }] }).messages[0].kind, 'status');
assert.ok(alreadyAdminMessaged([{ role: 'assistant', kind: 'admin' }]));
assert.ok(!alreadyAdminMessaged([{ role: 'assistant', kind: 'welcome' }]));
assert.ok(alreadyKycDocsAsked([{ role: 'assistant', kind: 'kyc_docs' }]));
assert.ok(!alreadyKycDocsAsked([{ role: 'assistant', kind: 'kyc_docs', sendError: 'timeout' }]));
const docs = kycDocsRequestText();
assert.ok(/PAN Card/.test(docs));
assert.ok(/Aadhaar Card/.test(docs));
assert.ok(/Bank Statement/i.test(docs));
assert.ok(/Salary Slip/i.test(docs));
assert.strictEqual(asChat({ messages: [{ id: 'docs:1', role: 'assistant', kind: 'kyc_docs', text: 'x' }] }).messages[0].kind, 'kyc_docs');
const kycView = kycChatText('Atul', 'personal_loan');
assert.ok(/Hello Atul!/.test(kycView));
assert.ok(/Personal Loan file/.test(kycView));
assert.ok(/KYC start karein/.test(kycView));
assert.ok(/Haan, KYC Start/.test(KYC_START_BTN));

const pdfIn = extractInboundMessages({
  object: 'whatsapp_business_account',
  entry: [
    {
      changes: [
        {
          value: {
            contacts: [{ profile: { name: 'Atul' }, wa_id: '919876543210' }],
            messages: [
              {
                from: '919876543210',
                id: 'wamid.pdf',
                type: 'document',
                document: { id: 'media-pdf-1', mime_type: 'application/pdf', filename: 'pan.pdf', caption: '' },
              },
            ],
          },
        },
      ],
    },
  ],
});
assert.strictEqual(pdfIn[0].waType, 'document');
assert.strictEqual(pdfIn[0].mediaId, 'media-pdf-1');
assert.strictEqual(pdfIn[0].filename, 'pan.pdf');
assert.ok(isGraphTimeout('The operation was aborted due to timeout'));
assert.ok(!isGraphTimeout('131047: Message expired'));

console.log('test-whatsapp-webhook: all asserts passed');
