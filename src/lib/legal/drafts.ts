// Program-Fix 15 PR A — the legal copy for /terms, /privacy and /legal, as
// structured DRAFTS for counsel review (owner decision, 2026-09-23).
//
// Rules for anyone editing this file:
//  - Every page that renders a draft shows LEGAL_DRAFT_BANNER. Nothing here may
//    claim the text has been signed off (tests/legal-pages.test.ts scans for it).
//  - Provider of record (recommendation C3): the licensed partner named on the
//    customer's receipt is the money transmitter. SmartRemit is the technology
//    provider and never holds, receives or disburses customer funds.
//  - Invent nothing: no entity names, licence numbers, regulators or phone
//    numbers. Per-partner details come from the partner's own configuration.
//  - Rule references are to 12 CFR Part 1005, Subpart B (Regulation E,
//    remittance transfers): §1005.30-.36.
//  - Bump LEGAL_DRAFT_VERSION on any change to the text, so the version shown on
//    the page (and, from PR B, recorded with a disclosure acknowledgement)
//    identifies the exact wording.

export const LEGAL_DRAFT_VERSION = 'draft-2026-09-23' as const;

/** Shown verbatim at the top of every legal page. */
export const LEGAL_DRAFT_BANNER = 'Draft — for counsel review; not legal advice and not yet approved';

export interface LegalSection {
  /** Anchor id on the page (kebab-case, unique within its document). */
  id: string;
  heading: string;
  paragraphs: readonly string[];
  bullets?: readonly string[];
}

export interface LegalDraft {
  /** Anchor id of the document itself (used by /legal, which renders several). */
  id: string;
  title: string;
  summary: string;
  version: typeof LEGAL_DRAFT_VERSION;
  sections: readonly LegalSection[];
}

/**
 * The demonstration runs on the default tenant, whose brand is SmartRemit: it
 * must never read as SmartRemit being the licensed transmitter. Shown in the
 * LICENSING provider section and the /about footer.
 */
export const DEMO_NO_PARTNER_NOTE =
  '(Demonstration: no licensed partner is attached and no real money moves.)';

const PROVIDER_OF_RECORD =
  'Your money transmitter is the licensed partner named on your receipt. SmartRemit is the technology provider: it runs the chat, the quote and the pay page for that partner, and it never holds, receives or disburses your money.';

export const TERMS_DRAFT: LegalDraft = {
  id: 'terms',
  title: 'Terms of Service',
  summary:
    'The terms that apply when you use SmartRemit-powered chat, quotes and pay pages to send money through a licensed partner.',
  version: LEGAL_DRAFT_VERSION,
  sections: [
    {
      id: 'who-provides',
      heading: 'Who provides your transfer',
      paragraphs: [
        PROVIDER_OF_RECORD,
        'The partner is responsible for receiving your payment, delivering the funds to your recipient, and handling refunds. Its name and contact details will appear on your receipt once partner disclosures are enabled.',
      ],
    },
    {
      id: 'eligibility',
      heading: 'Who can use the service',
      paragraphs: [
        'You must be at least 18 years old, able to enter a binding agreement, and sending money for yourself. You must give true, current and complete information about yourself and your recipient.',
      ],
    },
    {
      id: 'quotes-and-fees',
      heading: 'Quotes, exchange rates and fees',
      paragraphs: [
        'Before you pay, you are shown the amount you send, the fees, the total you pay, the exchange rate and the amount your recipient will receive. When you confirm a quote in the chat, the exchange rate is locked for about 10 minutes. If the quote has expired by the time you pay, the pay page will not take payment and you are asked for a fresh quote.',
        'Your recipient’s bank or wallet provider may charge its own fees, which are not included in the amount shown.',
      ],
    },
    {
      id: 'payment',
      heading: 'Paying for a transfer',
      paragraphs: [
        'You pay on a secure pay page for your transfer. Money moves only through that page; a chat message never moves money on its own. A pay link is personal to you: do not share it.',
      ],
    },
    {
      id: 'checks',
      heading: 'Identity and screening checks',
      paragraphs: [
        'Every transfer is screened against government sanctions lists, and the partner may ask you to verify your identity. A transfer may be held for review, delayed or refused where the law requires it or where the partner reasonably suspects fraud or misuse. Where the law allows, you will be told and any payment returned.',
      ],
    },
    {
      id: 'cancellation-and-errors',
      heading: 'Cancellation, refunds and errors',
      paragraphs: [
        'Your rights to cancel a transfer within 30 minutes of paying, and to have errors investigated and corrected, are set out in the Remittance transfer rights section of the Legal page. Nothing in these terms limits those rights.',
      ],
    },
    {
      id: 'your-responsibilities',
      heading: 'Your responsibilities',
      paragraphs: [
        'Check the recipient’s name and payout details before you pay. You must not use the service for anything unlawful, including sending money on behalf of someone else to avoid identity checks, or splitting payments to avoid limits.',
      ],
    },
    {
      id: 'assistant',
      heading: 'The chat assistant',
      paragraphs: [
        'The chat is run by an AI assistant. Its answers can be wrong; the pay page and your receipt are the record of what you agreed and paid. If something looks wrong, contact the licensed partner named on your receipt.',
      ],
    },
    {
      id: 'service-availability',
      heading: 'Service availability',
      paragraphs: [
        'The service may be unavailable from time to time, and delivery times are estimates. Some money movement on this site is simulated today, for demonstration.',
      ],
    },
    {
      id: 'changes',
      heading: 'Changes to these terms',
      paragraphs: [
        'These terms may change. The version identifier at the top of this page changes whenever the wording does, and the terms in force when you pay apply to that transfer.',
      ],
    },
    {
      id: 'contact',
      heading: 'Contact',
      paragraphs: [
        'For a question about a transfer, contact the licensed partner named on your receipt. For a question about the SmartRemit technology, write to support@smartremit.ai.',
      ],
    },
  ],
};

export const PRIVACY_DRAFT: LegalDraft = {
  id: 'privacy',
  title: 'Privacy Notice',
  summary:
    'What personal information is collected when you send money through a SmartRemit-powered service, why, who it is shared with, and the choices you have.',
  version: LEGAL_DRAFT_VERSION,
  sections: [
    {
      id: 'who-is-responsible',
      heading: 'Who is responsible for your information',
      paragraphs: [
        PROVIDER_OF_RECORD,
        'The partner decides how your transfer information is used for its financial service. SmartRemit processes that information on the partner’s behalf to run the chat, quotes, screening and pay page, and for no other purpose.',
      ],
    },
    {
      id: 'what-we-collect',
      heading: 'Information collected',
      paragraphs: ['Depending on what you do, this can include:'],
      bullets: [
        'Contact details: your phone number, and your email address if you create an account.',
        'Identity details the partner needs to verify you, such as your legal name, date of birth, address, nationality, occupation, source of funds, whether you hold a public position (politically exposed person), and identity document details.',
        'Transfer details: amounts, the recipient’s name and payout details, and the transfer history.',
        'Messages you send in the chat.',
        'Technical details from the pay page and account pages, such as IP address and browser type, used for security and fraud prevention.',
      ],
    },
    {
      id: 'how-it-is-used',
      heading: 'How it is used',
      paragraphs: ['Your information is used to:'],
      bullets: [
        'quote, set up and complete the transfers you ask for;',
        'verify your identity and screen transfers against sanctions lists, as the law requires;',
        'prevent fraud and keep the service secure;',
        'answer your questions and send you updates about your transfers;',
        'keep records the law requires.',
      ],
    },
    {
      id: 'glba-notice',
      heading: 'Financial privacy notice (GLBA-style)',
      paragraphs: [
        'Federal law gives consumers the right to limit some but not all sharing of personal information by financial institutions, and requires that you be told how your information is collected, shared and protected. The licensed partner named on your receipt is the financial institution for your transfer; this section describes the sharing that the service built on SmartRemit performs for it.',
        'Reasons your personal information can be shared:',
      ],
      bullets: [
        'For everyday business purposes, such as processing your transfers, responding to court orders and legal investigations, and reporting as the law requires: yes; you cannot limit this sharing.',
        'With service providers acting for the partner, such as SmartRemit, messaging (WhatsApp), identity-verification, AI model, hosting and database providers: yes; you cannot limit this sharing.',
        'For the partner’s or SmartRemit’s own marketing: no such sharing takes place.',
        'For joint marketing with other financial companies: no such sharing takes place.',
        'With affiliates or non-affiliates so they can market to you: no such sharing takes place.',
      ],
    },
    {
      id: 'whatsapp',
      heading: 'WhatsApp and the chat assistant',
      paragraphs: [
        'If you use the service on WhatsApp, your messages pass through WhatsApp, which is operated by Meta under its own terms and privacy policy. WhatsApp shows the service your phone number, your WhatsApp profile name and the messages you send.',
        'Your messages are processed by an AI model provider to generate replies. Conversation history used to continue a conversation is kept until 30 days after your last message. Some records of message processing are kept longer: internal delivery records hold message content for about 7 days, records of failed deliveries and messages you send to support are kept until they are reviewed or deleted, and transfer records are kept separately, as described below.',
        'Never send card numbers, bank passwords or one-time codes in the chat. Payment details are entered only on the pay page.',
      ],
    },
    {
      id: 'security',
      heading: 'How your information is protected',
      paragraphs: [
        'Payout details, recipient names and customer identity information are encrypted at rest. Staff access to unmasked details is restricted and recorded.',
      ],
    },
    {
      id: 'retention',
      heading: 'How long it is kept',
      paragraphs: [
        'Transfer and identity records are kept for as long as financial-services law requires the partner to keep them. Conversation history is kept for a shorter period, as described above; support messages are kept with the records of your account.',
      ],
    },
    {
      id: 'your-choices',
      heading: 'Your choices',
      paragraphs: [
        'You can ask for a copy of your information, ask for it to be corrected, or ask for it to be deleted where the law allows. Some records must be kept even after you ask for deletion. To make a request, contact the licensed partner named on your receipt or write to support@smartremit.ai.',
      ],
    },
    {
      id: 'children',
      heading: 'Children',
      paragraphs: ['The service is not meant for anyone under 18, and information about children is not knowingly collected.'],
    },
    {
      id: 'changes',
      heading: 'Changes to this notice',
      paragraphs: ['This notice may change. The version identifier at the top of this page changes whenever the wording does.'],
    },
  ],
};

export const REMITTANCE_RIGHTS_DRAFT: LegalDraft = {
  id: 'remittance-rights',
  title: 'Remittance transfer rights',
  summary:
    'Your rights under federal law (Regulation E, 12 CFR 1005 Subpart B) when you send money abroad for personal, family or household purposes: error resolution and cancellation.',
  version: LEGAL_DRAFT_VERSION,
  sections: [
    {
      id: 'status',
      heading: 'Status of this section',
      paragraphs: [
        'The mechanics that honour these rights, including the 30-minute cancellation with a refund within three business days and the error-resolution timelines, are still being built; this wording may change.',
      ],
    },
    {
      id: 'error-resolution',
      heading: 'What to do if you think there has been an error or problem',
      paragraphs: [
        'If you think there has been an error or problem with your remittance transfer, contact the licensed partner named on your receipt, or reply in the WhatsApp chat where you arranged the transfer, quoting the transfer ID shown on your receipt.',
        'You must contact the partner within 180 days of the date the funds were promised to be available to your recipient. When you do, tell them:',
      ],
      bullets: [
        'your name and address or telephone number;',
        'the error or problem with the transfer, and why you believe it is an error or problem;',
        'the name of the person receiving the funds and, if you know it, their telephone number or address;',
        'the dollar amount of the transfer;',
        'the confirmation code or number of the transfer.',
      ],
    },
    {
      id: 'error-investigation',
      heading: 'How an error is investigated',
      paragraphs: [
        'The partner will determine whether an error occurred within 90 days after you contact it and will correct any error promptly. You will be told the results within three business days after the investigation is complete. If the partner decides there was no error, it will send you a written explanation. You may ask for copies of any documents used in the investigation.',
      ],
    },
    {
      id: 'cancellation',
      heading: 'What to do if you want to cancel a remittance transfer',
      paragraphs: [
        'You have the right to cancel a remittance transfer and obtain a refund of all funds paid, including any fees. To cancel, you must contact the licensed partner named on your receipt, or reply in the WhatsApp chat where you arranged the transfer, within 30 minutes of paying for the transfer.',
        'When you contact the partner, give information that identifies the transfer, including the amount and where the funds were sent. The partner will refund your money within three business days of your request, as long as the funds have not already been picked up or deposited into your recipient’s account.',
        'Many transfers are delivered within minutes. If the funds have already been deposited or picked up, the transfer can no longer be cancelled, but you may still report an error as described above.',
      ],
    },
    {
      id: 'complaints',
      heading: 'Complaints',
      paragraphs: [
        'If you have a complaint, contact the licensed partner named on your receipt first. Once partner disclosures are enabled, your receipt will also name the state regulator that licenses the partner, where the partner has supplied it.',
        'You can also contact the Consumer Financial Protection Bureau at consumerfinance.gov/complaint or 855-411-2372.',
      ],
    },
  ],
};

export const LICENSING_DRAFT: LegalDraft = {
  id: 'licensing',
  title: 'Licensing and regulatory information',
  summary: 'Who is licensed to move your money, and what SmartRemit does.',
  version: LEGAL_DRAFT_VERSION,
  sections: [
    {
      id: 'provider',
      heading: 'Who provides your transfer',
      paragraphs: [
        'Transfers are provided by the licensed partner named on your receipt. That partner is the money transmitter for your transfer and holds the licences required to provide it.',
        'Once partner disclosures are enabled, your receipt will show the partner’s name and contact details, and its licence and state-regulator details where the partner has supplied them. Where a detail has not been supplied, nothing will be shown in its place.',
        DEMO_NO_PARTNER_NOTE,
      ],
    },
    {
      id: 'smartremit-role',
      heading: 'What SmartRemit does',
      paragraphs: [
        'SmartRemit is a technology provider. It builds and runs the chat, quoting, screening and pay-page software that licensed partners offer under their own brand. SmartRemit never holds, receives or disburses customer money: funds move only on the partner’s own payment rails.',
      ],
    },
    {
      id: 'demonstration',
      heading: 'Demonstration status',
      paragraphs: [
        'Some money movement on this site is simulated today, for demonstration. A simulated transfer moves no real money.',
      ],
    },
  ],
};

export const SCHEDULED_TRANSFERS_DRAFT: LegalDraft = {
  id: 'scheduled-transfers',
  title: 'Transfers scheduled in advance',
  summary: 'How the disclosure and cancellation rules differ for transfers you schedule ahead of time (12 CFR 1005.36).',
  version: LEGAL_DRAFT_VERSION,
  sections: [
    {
      id: 'scheduled-note',
      heading: 'Scheduled and recurring transfers',
      paragraphs: [
        'Today, when you set up a recurring transfer in the chat, you are sent a pay link on each scheduled date, and you review and pay each transfer on the pay page. Disclosures at the time you set up the schedule are not yet shown. You can cancel a schedule at any time by asking in the chat.',
        'For a transfer scheduled at least three business days in advance, federal rules call for the disclosures to be given when you schedule it, and for you to be able to cancel it at least three business days before the scheduled date. How the service will meet those rules is still being worked out.',
        'This part of the service is still being reviewed, and the wording here may change.',
      ],
    },
  ],
};

/** Every draft, in the order counsel should read them. */
export const LEGAL_DRAFTS: readonly LegalDraft[] = [
  TERMS_DRAFT,
  PRIVACY_DRAFT,
  REMITTANCE_RIGHTS_DRAFT,
  LICENSING_DRAFT,
  SCHEDULED_TRANSFERS_DRAFT,
];
