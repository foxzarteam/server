import { Controller, Get, Header } from '@nestjs/common';

/** Machine-readable contract for third-party integrations. Browser az_web uses Next BFF. */
export const OPENAPI_SPEC = {
  openapi: '3.0.3',
  info: {
    title: 'Apni Zaroorat API',
    version: '1.0.0',
    description:
      'REST API (Nest). Prefix /api. Admin/CRM routes require x-admin-internal-key + signed x-admin-actor. Public apply/OTP remain available for first-party BFF and third parties.',
  },
  servers: [{ url: '/api' }],
  paths: {
    '/health': {
      get: { summary: 'Health ping', responses: { '200': { description: 'ok' } } },
    },
    '/auth/login': {
      post: {
        summary: 'Admin/staff email login',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['email', 'password'],
                properties: { email: { type: 'string' }, password: { type: 'string' } },
              },
            },
          },
        },
        responses: { '200': { description: 'Verified user' }, '401': { description: 'Invalid' } },
      },
    },
    '/users/agent/login': {
      post: {
        summary: 'Partner login (mobile + 4-digit PIN)',
        responses: { '200': { description: 'Partner profile' }, '401': { description: 'Invalid' } },
      },
    },
    '/users/agent/register': {
      post: {
        summary: 'Public partner register (name + mobile + 4-digit PIN, no OTP)',
        responses: {
          '201': { description: 'Created' },
          '409': { description: 'Mobile already registered' },
        },
      },
    },
    '/otp/request-send': {
      post: { summary: 'Reserve OTP send slot (daily + IP limits)', responses: { '200': { description: 'Allowed or blocked' } } },
    },
    '/otp/verify-firebase': {
      post: { summary: 'Verify Firebase idToken against mobile', responses: { '200': { description: 'Verified' } } },
    },
    '/leads/check-application': {
      post: { summary: 'Pre-OTP PAN/product gate', responses: { '200': { description: 'allowed + status' } } },
    },
    '/leads/apply': {
      post: {
        summary:
          'Public apply (loan + insurance, one endpoint). Saves lead Verified=No. OTP later sets Verified=Yes. Ignores client userId; referralCode only.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['pan', 'mobileNumber', 'fullName', 'category', 'pincode'],
                properties: {
                  pan: { type: 'string', example: 'ABCDE1234F' },
                  mobileNumber: { type: 'string', example: '9876543210' },
                  fullName: { type: 'string', example: 'Rahul Sharma' },
                  pincode: { type: 'string', example: '302002' },
                  category: {
                    type: 'string',
                    enum: ['personal_loan', 'insurance'],
                    example: 'personal_loan',
                  },
                  requiredAmount: { type: 'number', example: 500000, description: 'PL only, ₹25,000–₹10,00,000' },
                  employmentType: { type: 'string', enum: ['salaried', 'self_employed'] },
                  netMonthlyIncome: { type: 'number', example: 45000 },
                  insType: {
                    type: 'string',
                    enum: ['life_insurance', 'health_insurance', 'motor_insurance', 'cyber_insurance'],
                    description: 'Required when category=insurance',
                  },
                  referralCode: { type: 'string', description: 'Partner referral code (optional)' },
                },
              },
            },
          },
        },
        responses: {
          '201': { description: 'Lead created (otp_verified false)' },
          '409': { description: 'PAN/product conflict or 4-PAN mobile limit' },
        },
      },
    },
    '/leads/start': {
      post: { summary: 'Create/reuse draft after OTP', responses: { '201': { description: 'Draft' } } },
    },
    '/leads/{id}/complete': {
      patch: { summary: 'Complete draft (phone access required)', responses: { '200': { description: 'Updated' } } },
    },
    '/leads/admin': {
      post: { summary: 'CRM/partner manual lead create (signed actor)', responses: { '201': { description: 'Created' } } },
    },
    '/leads/admin/{id}': {
      patch: {
        summary: 'CRM update. Approve / commission fields: admin actor only.',
        responses: { '200': { description: 'Updated' }, '403': { description: 'Admin only' } },
      },
      delete: { summary: 'Admin-only delete', responses: { '200': { description: 'Deleted' } } },
    },
    '/leads/admin/{id}/pan/reveal': {
      post: { summary: 'Reveal full PAN (CRM actor + audit)', responses: { '200': { description: 'PAN' } } },
    },
    '/customer/login': {
      post: { summary: 'Customer track login (Firebase idToken)', responses: { '200': { description: 'Applications' } } },
    },
    '/contact': {
      post: { summary: 'Public contact form', responses: { '201': { description: 'Saved' } } },
    },
    '/services': {
      get: { summary: 'Public active products', responses: { '200': { description: 'List' } } },
    },
    '/wallet/user/{userId}': {
      get: { summary: 'Wallet for owner (strict mobile access or CRM actor)', responses: { '200': { description: 'Wallet' } } },
    },
  },
} as const;

@Controller()
export class OpenApiController {
  @Get('openapi.json')
  @Header('Cache-Control', 'public, max-age=300')
  spec() {
    return OPENAPI_SPEC;
  }
}
