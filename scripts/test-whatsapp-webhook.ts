/**
 * WhatsApp Meta hub.verify_token handshake.
 * From server/:  npx ts-node --transpile-only scripts/test-whatsapp-webhook.ts
 */
import assert from 'assert';
import { createHmac } from 'crypto';
import { graphMessageBody, isGraphTimeout } from '../src/whatsapp/whatsapp-graph';
import { whatsappHubChallenge, whatsappSignatureOk } from '../src/whatsapp/whatsapp-verify';
import { adminTargetPhone, canonicalWhatsappPhone, extractInboundMessages } from '../src/whatsapp/whatsapp-inbound';
import { decryptSettingsJson, encryptSettingsJson } from '../src/whatsapp/settings-crypto';
import { adminCustomerName, asChat, unreadCustomerCount } from '../src/whatsapp/whatsapp-chat';
import { kycBodyName, kycChatText, kycGraphPayload, kycProductName, KYC_START_BTN, KYC_TEMPLATE, KYC_TEMPLATE_LANG } from '../src/whatsapp/whatsapp-kyc';
import { isGreeting, pickBotReply } from '../src/whatsapp/whatsapp-bot-rules';
import {
  alreadyAdminMessaged,
  alreadyKycDocsAsked,
  alreadyKycStarted,
  alreadyWelcomed,
  insuranceText,
  isKycStartClick,
  isKycStatusClick,
  kycDocsRequestText,
  rejectedText,
  personalLoanText,
  productChoice,
  statusCheckText,
  withCachedProductImage,
  welcomeInteractive,
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
assert.deepStrictEqual(
  welcomeInteractive('hi').interactive.action.buttons.map((btn) => btn.reply.title),
  ['Loan', 'Insurance'],
);
assert.ok(/do you need a Loan or Insurance/.test(welcomeText('Gaurav')));
assert.ok(!/Personal Loan/.test(welcomeText('Gaurav')));
assert.ok(!/Navya/i.test(welcomeText('Gaurav')));
assert.ok(/apnizaroorat.com\/products\/loans\//.test(personalLoanText('Gaurav')));
assert.ok(/\n\nThe best loan options/.test(personalLoanText('Gaurav')));
assert.ok(/\n\nHealth, Bike, Life/.test(insuranceText('Gaurav')));
assert.ok(/apnizaroorat.com\/products\/insurance\//.test(insuranceText('Gaurav')));
assert.ok(/Health, Bike, Life/.test(insuranceText('Gaurav')));
assert.ok(!/50 Lakh/i.test(personalLoanText('Gaurav')));
const loanImage = {
  id: 'ai:loan',
  role: 'assistant' as const,
  text: personalLoanText('Gaurav'),
  at: '2026-01-01T00:00:00.000Z',
  kind: 'personal_loan' as const,
  filename: 'wa_loa.jpg',
};
const loanLinked = withCachedProductImage(loanImage, '');
assert.strictEqual(loanLinked.mediaId, undefined);
assert.ok(loanLinked.mediaUrl?.endsWith('/images/whatsapp/wa_loa.jpg'));
const loanCached = withCachedProductImage(loanImage, 'media-1');
assert.strictEqual(loanCached.mediaId, 'media-1');
assert.strictEqual(loanCached.mediaUrl, undefined);
const loanBody = graphMessageBody('919876543210', loanLinked) as { type?: string; image?: { link?: string } };
assert.strictEqual(loanBody.type, 'image');
assert.ok(loanBody.image?.link?.endsWith('/images/whatsapp/wa_loa.jpg'));
const insLinked = withCachedProductImage({ ...loanImage, kind: 'insurance', filename: 'wa_ins.jpg', text: insuranceText('Gaurav') }, '');
assert.ok(insLinked.mediaUrl?.endsWith('/images/whatsapp/wa_ins.jpg'));
assert.ok(alreadyWelcomed([{ role: 'assistant', kind: 'welcome', text: welcomeText('Gaurav') }]));
assert.ok(!alreadyWelcomed([{ role: 'assistant', kind: 'welcome', text: welcomeText('Gaurav'), sendError: 'timeout' }]));
assert.ok(!alreadyWelcomed([{ role: 'user', text: 'Hi' }]));

assert.strictEqual(kycBodyName('  Raju   Patel\n'), 'Raju Patel');
assert.strictEqual(kycProductName('personal_loan'), 'Personal Loan');
assert.strictEqual(kycProductName('home_loan'), 'Home Loan');
assert.strictEqual(kycProductName('insurance'), 'Insurance');
assert.strictEqual(kycProductName('insurance', 'health_insurance'), 'Health Insurance');
const kycPayload = kycGraphPayload('919876543210', 'Raju Patel', 'insurance', 'en_GB') as {
  template: { name: string; language: { code: string }; components: { parameters: { text: string }[] }[] };
};
assert.strictEqual(kycPayload.template.name, 'application_kyc');
assert.strictEqual(KYC_TEMPLATE, 'application_kyc');
assert.strictEqual(KYC_TEMPLATE_LANG, 'en_GB');
assert.strictEqual(kycPayload.template.language.code, KYC_TEMPLATE_LANG);
assert.strictEqual(kycPayload.template.components[0].parameters.length, 1);
assert.strictEqual(kycPayload.template.components[0].parameters[0].text, 'Raju Patel');
assert.ok(alreadyKycStarted([{ role: 'assistant', kind: 'kyc' }]));
assert.ok(!alreadyKycStarted([{ role: 'assistant', kind: 'kyc', sendError: 'timeout' }]));
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
assert.ok(isKycStartClick('Complete KYC', ''));
assert.ok(isKycStartClick('', 'Complete KYC'));
assert.ok(isKycStartClick('Start KYC', ''));
assert.ok(isKycStartClick('kyc_start', ''));
assert.ok(!isKycStartClick('Application Status Check Karein', ''));
assert.ok(isKycStatusClick('Application Status Check Karein', ''));
assert.ok(isKycStatusClick('', 'Application Status Check Karein'));
assert.ok(!isKycStatusClick('Haan, KYC Start Karein', ''));
assert.ok(!isKycStatusClick('Haan, KYC Start Karein', 'Application Status Check Karein'));
assert.ok(isKycStatusClick('Check Application Status', ''));
assert.ok(!isKycStatusClick('Complete KYC', ''));
const statusText = statusCheckText();
const statusPayload = graphMessageBody('919876543210', {
  id: 'ai:status',
  role: 'assistant',
  text: statusText,
  at: '2026-01-01T00:00:00.000Z',
  kind: 'status',
  waType: 'text',
}) as { text?: { preview_url?: boolean; body?: string } };
assert.strictEqual(statusPayload?.text?.preview_url, false);
assert.ok(/registered phone number/i.test(statusText));
assert.ok(statusText.includes('https://apnizaroorat.com/customer/login'));
assert.ok(!statusText.includes('customer/login/'));
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
assert.ok(/please share clear photos or PDFs/.test(docs));
assert.ok(/PAN Card/.test(docs));
assert.ok(/Aadhaar Card/.test(docs));
assert.ok(/Bank Statement/.test(docs));
assert.ok(/Salary Slips/.test(docs));
assert.ok(/Passport-Size Photo/.test(docs));
assert.ok(!/CIBIL/.test(docs));
assert.ok(!/ITR/.test(docs));
assert.ok(!/Thank you/.test(docs));
const businessDocs = kycDocsRequestText('self_employed');
assert.ok(/Last 12 Months/.test(businessDocs));
assert.ok(/ITR with Computation/.test(businessDocs));
assert.ok(/GST \/ Udyam \/ Shop Licence/.test(businessDocs));
assert.ok(/Passport-Size Photo/.test(businessDocs));
assert.ok(!/CIBIL/.test(businessDocs));
assert.ok(!/Salary Slips/.test(businessDocs));
assert.strictEqual(kycDocsRequestText('salaried'), docs);
const vehicleDocs = kycDocsRequestText('self_employed', 'vehicle_loan');
assert.ok(/PAN Card/.test(vehicleDocs));
assert.ok(/Aadhaar Card/.test(vehicleDocs));
assert.ok(/Passport-Size Photo/.test(vehicleDocs));
assert.ok(/Vehicle Quotation 🚗 OR RC \(if you have\)/.test(vehicleDocs));
assert.ok(!/5️⃣/.test(vehicleDocs));
assert.ok(!/Salary Slips/.test(vehicleDocs));
assert.ok(!/Bank Statement/.test(vehicleDocs));
assert.ok(!/ITR/.test(vehicleDocs));
assert.strictEqual(kycDocsRequestText(null, 'car_loan'), vehicleDocs);

const rejectedNote = rejectedText();
assert.strictEqual(rejectedNote.split('\n').filter((line) => line.trim()).length, 2);
assert.ok(rejectedNote.includes('Thank you for applying with Apni Zaroorat. 🙏'));
assert.ok(rejectedNote.includes('could not be approved'));
assert.strictEqual(asChat({ messages: [{ id: 'docs:1', role: 'assistant', kind: 'kyc_docs', text: 'x' }] }).messages[0].kind, 'kyc_docs');
const kycView = kycChatText('Atul', 'personal_loan');
assert.ok(/Dear Atul\./.test(kycView));
assert.ok(/application is in progress/.test(kycView));
assert.ok(/KYC verification is pending/.test(kycView));
assert.strictEqual(KYC_START_BTN, 'Complete KYC');

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

const hiddenFile = extractInboundMessages({
  object: 'whatsapp_business_account',
  entry: [
    {
      changes: [
        {
          value: {
            messages: [
              {
                from: '919876543210',
                id: 'wamid.hidden',
                type: 'unsupported',
                document: { id: 'media-doc-9', mime_type: 'application/pdf', filename: 'statement.pdf' },
                errors: [{ code: 131051, title: 'Message type unknown' }],
              },
              {
                from: '919876543210',
                id: 'wamid.photo-doc',
                type: 'document',
                document: { id: 'media-jpg', mime_type: 'image/jpeg', filename: 'aadhaar.jpg' },
              },
              {
                from: '919876543210',
                id: 'wamid.edit',
                type: 'unsupported',
                unsupported: { type: 'edit' },
              },
            ],
          },
        },
      ],
    },
  ],
});
assert.strictEqual(hiddenFile.length, 2);
assert.strictEqual(hiddenFile[0].mediaId, 'media-doc-9');
assert.strictEqual(hiddenFile[0].waType, 'document');
assert.strictEqual(hiddenFile[0].filename, 'statement.pdf');
assert.strictEqual(hiddenFile[1].waType, 'image');
assert.strictEqual(hiddenFile[1].mediaId, 'media-jpg');
assert.ok(!hiddenFile.some((item) => /unsupported/i.test(item.text)));

const album = extractInboundMessages({
  object: 'whatsapp_business_account',
  entry: [
    {
      changes: [
        {
          value: {
            messages: [
              {
                from: '919876543210',
                id: 'wamid.album',
                type: 'unsupported',
                errors: [{ code: 131051, title: 'Message type unknown' }],
              },
              {
                from: '919876543210',
                id: 'wamid.shot1',
                type: 'image',
                image: { id: 'media-1', mime_type: 'image/jpeg' },
              },
              {
                from: '919876543210',
                id: 'wamid.shot2',
                type: 'image',
                image: { id: 'media-2', mime_type: 'image/jpeg' },
              },
            ],
          },
        },
      ],
    },
  ],
});
assert.strictEqual(album.length, 2);
assert.ok(album.every((item) => item.mediaId));

const notice = 'This file did not come through. Ask the customer to send it again as a photo or PDF.';
const withPhotos = asChat({
  messages: [
    { id: 'miss', role: 'user', text: notice, at: '2026-10-14T01:15:00.000Z' },
    { id: 'pic', role: 'user', text: 'Photo', at: '2026-10-14T01:15:02.000Z', waType: 'image', mediaId: 'media-1' },
  ],
});
assert.strictEqual(withPhotos.messages.length, 1);
assert.strictEqual(withPhotos.messages[0].id, 'pic');
const alone = asChat({
  messages: [{ id: 'miss', role: 'user', text: notice, at: '2026-10-14T01:15:00.000Z' }],
});
assert.strictEqual(alone.messages.length, 1);
assert.strictEqual(alone.messages[0].text, notice);

const voice = extractInboundMessages({
  object: 'whatsapp_business_account',
  entry: [
    {
      changes: [
        {
          value: {
            messages: [
              {
                from: '919876543210',
                id: 'wamid.voice',
                type: 'audio',
                audio: { id: 'media-voice', mime_type: 'audio/ogg', voice: true },
              },
              {
                from: '919876543210',
                id: 'wamid.anyfile',
                type: 'unsupported',
                file: { id: 'media-zip', mime_type: 'application/zip', filename: 'papers.zip', sha256: 'abc' },
              },
            ],
          },
        },
      ],
    },
  ],
});
assert.strictEqual(voice[0].waType, 'audio');
assert.strictEqual(voice[0].mediaId, 'media-voice');
assert.strictEqual(voice[1].waType, 'document');
assert.strictEqual(voice[1].filename, 'papers.zip');
assert.strictEqual(voice[1].mediaId, 'media-zip');
assert.ok(isGraphTimeout('The operation was aborted due to timeout'));
assert.ok(!isGraphTimeout('131047: Message expired'));

assert.ok(isGreeting('Hello'));
assert.ok(isGreeting('hi'));
assert.ok(isGreeting('Namaste'));
assert.ok(isGreeting('hello 👋'));
assert.ok(!isGreeting('I need a loan update'));
const idle = { kyc: false, kycDocs: false, welcomed: false, offered: false, thanked: false };
assert.strictEqual(pickBotReply('', 'Hello', idle).kind, 'welcome');
assert.strictEqual(pickBotReply('', 'Hello', { ...idle, welcomed: true }).kind, null);
assert.strictEqual(pickBotReply('', 'Hello', { ...idle, kyc: true, welcomed: false }).kind, null);
assert.strictEqual(pickBotReply('', '?', { ...idle, kyc: true }).kind, null);
assert.strictEqual(pickBotReply('personal_loan', '', { ...idle, kyc: true }).kind, null);
assert.strictEqual(pickBotReply('insurance', '', { ...idle, kyc: true }).kind, null);
assert.ok(alreadyKycStarted([{ role: 'assistant', text: 'Dear Atul. Your account application is in progress. KYC verification is pending. Complete it in just 2 mins' }]));
assert.ok(!alreadyKycStarted([{ role: 'user', text: 'KYC verification is pending' }]));
assert.strictEqual(pickBotReply('', 'Okay which bank ?', { ...idle, kyc: true, welcomed: false }).kind, null);
assert.ok(alreadyKycStarted([{ role: 'assistant', text: 'To complete your KYC, please share clear photos or PDFs of these documents:' }]));
assert.ok(alreadyKycStarted([{ role: 'assistant', kind: 'under_review', text: 'We have successfully received your KYC documents.' }]));
assert.ok(alreadyKycStarted([{ role: 'assistant', text: 'We have successfully received your KYC documents. Your application is under review.' }]));
assert.strictEqual(pickBotReply('Haan, KYC Start Karein', '', idle).kind, 'kyc_docs');
assert.strictEqual(pickBotReply('Complete KYC', '', idle).kind, 'kyc_docs');
assert.strictEqual(pickBotReply('Application Status Check Karein', '', idle).kind, 'status');
assert.strictEqual(pickBotReply('Application Status Check Karein', '', { ...idle, statusSent: true }).kind, null);
assert.strictEqual(pickBotReply('personal_loan', '', idle).kind, 'personal_loan');
assert.strictEqual(pickBotReply('personal_loan', '', { ...idle, loanOffered: true }).kind, null);
assert.strictEqual(pickBotReply('personal_loan', '', { ...idle, product: 'personal_loan' }).kind, 'personal_loan');
assert.strictEqual(pickBotReply('insurance', '', { ...idle, loanOffered: true }).kind, 'insurance');
assert.strictEqual(pickBotReply('insurance', '', { ...idle, insuranceOffered: true }).kind, null);
assert.strictEqual(pickBotReply('personal_loan', '', { ...idle, product: 'insurance', loanOffered: true }).kind, null);
assert.strictEqual(pickBotReply('', 'thanks', { ...idle, welcomed: true }).kind, null);

const unreadChat = asChat({
  adminReadAt: '2026-10-13T10:00:00.000Z',
  messages: [
    { id: 'u1', role: 'user', text: 'old', at: '2026-10-13T09:00:00.000Z' },
    { id: 'a1', role: 'assistant', text: 'reply', at: '2026-10-13T10:30:00.000Z' },
    { id: 'u2', role: 'user', text: 'new', at: '2026-10-13T11:00:00.000Z' },
    { id: 'u3', role: 'user', text: 'newer', at: '2026-10-13T11:05:00.000Z' },
  ],
});
assert.strictEqual(unreadCustomerCount(unreadChat), 2);
assert.strictEqual(unreadCustomerCount(asChat({ messages: unreadChat.messages })), 0);
assert.strictEqual(adminCustomerName('Jayu Patel', 'Jayu Kumar'), 'Jayu Kumar');
assert.strictEqual(adminCustomerName('Jayu Patel', ''), 'Jayu Patel');
assert.strictEqual(adminCustomerName('Jayu Patel', '   '), 'Jayu Patel');

console.log('test-whatsapp-webhook: all asserts passed');
