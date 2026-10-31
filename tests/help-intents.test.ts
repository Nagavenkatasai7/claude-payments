import { describe, it, expect } from 'vitest';
import { classifyHelpIntent, helpCaseReasonFor, helpIntentReply, helpIntentSkipsModel, type HelpIntent } from '@/lib/help-intents';
import { HELP_CASE_REPLIES } from '@/lib/hold-replies';

// R43: HELP always reaches a person, even when the model is down. The worker's
// router runs classifyHelpIntent on the customer's text BEFORE the model, so it
// must be deterministic and conservative: a clear request for help or a person
// matches; a send, a status question or "are you a human?" does not.

const cases: Array<[string, HelpIntent, string]> = [
  // English
  ['HELP', 'help', 'en'],
  ['help', 'help', 'en'],
  ['Help!', 'help', 'en'],
  ['please help', 'help', 'en'],
  ['I need help', 'help', 'en'],
  ['I want a human', 'human', 'en'],
  ['can I talk to a person?', 'human', 'en'],
  ['speak with an agent please', 'human', 'en'],
  ['connect me to customer service', 'human', 'en'],
  ['agent', 'human', 'en'],
  ['real person', 'human', 'en'],
  ['I want to file a complaint', 'complaint', 'en'],
  ['complaint', 'complaint', 'en'],
  ['my mom did not receive the money', 'money_problem', 'en'],
  ["the money hasn't arrived", 'money_problem', 'en'],
  ['I was charged twice', 'money_problem', 'en'],
  ['I sent the wrong amount', 'money_problem', 'en'],
  ["I didn't make this payment", 'unauthorised', 'en'],
  ['someone hacked my account', 'unauthorised', 'en'],
  ['this is fraud', 'unauthorised', 'en'],
  ['cancel', 'cancel', 'en'],
  ['cancel my transfer', 'cancel', 'en'],
  ['I want to cancel the payment', 'cancel', 'en'],
  // Hindi (Devanagari)
  ['मदद', 'help', 'hi'],
  ['मुझे मदद चाहिए', 'help', 'hi'],
  ['किसी इंसान से बात करनी है', 'human', 'hi'],
  ['मुझे शिकायत दर्ज करनी है', 'complaint', 'hi'],
  ['मेरी माँ को पैसे नहीं मिले', 'money_problem', 'hi'],
  ['यह धोखाधड़ी है', 'unauthorised', 'hi'],
  ['रद्द करें', 'cancel', 'hi'],
  // Hinglish
  ['madad chahiye', 'help', 'hinglish'],
  ['mujhe agent se baat karni hai', 'human', 'hinglish'],
  ['kisi insaan se baat karao', 'human', 'hinglish'],
  ['mujhe shikayat karni hai', 'complaint', 'hinglish'],
  ['mummy ko paise nahi mile', 'money_problem', 'hinglish'],
  ['maine yeh payment nahi kiya', 'unauthorised', 'hinglish'],
  ['transfer cancel karo', 'cancel', 'hinglish'],
  // Spanish
  ['ayuda', 'help', 'es'],
  ['necesito ayuda', 'help', 'es'],
  ['quiero hablar con una persona', 'human', 'es'],
  ['quiero poner una queja', 'complaint', 'es'],
  ['mi mamá no ha recibido el dinero', 'money_problem', 'es'],
  ['esto es una estafa', 'unauthorised', 'es'],
  ['cancelar la transferencia', 'cancel', 'es'],
];

describe('classifyHelpIntent: clear requests match, in EN, HI, Hinglish and ES', () => {
  it.each(cases)('%s → %s (%s)', (text, intent, lang) => {
    expect(classifyHelpIntent(text)).toEqual({ intent, lang });
  });
});

describe('classifyHelpIntent: everything else goes to the model', () => {
  it.each([
    'help me send 100 to mom',
    'can you help me send money?',
    'this is helpful, thanks',
    'helpful',
    'send $200 to Mom',
    'where is my money?',
    'what is the status of my transfer?',
    "I didn't receive the payment link",
    "I didn't get the verification code",
    'are you a human?',
    'are you a real person?',
    'is this a bot?',
    'am I talking to a human?',
    'eres una persona real?',
    'I have no complaints, thanks',
    'my agent in India will collect it',
    'transfer $100 to someone',
    'cancel the transfer and send it to my brother instead with a new amount of 500 dollars because mom already got paid last week',
    'hi',
    '',
    '   ',
  ])('%j → null', (text) => {
    expect(classifyHelpIntent(text)).toBeNull();
  });

  it('never throws on a non-string', () => {
    expect(classifyHelpIntent(undefined)).toBeNull();
    expect(classifyHelpIntent(42)).toBeNull();
    expect(classifyHelpIntent({ text: 'help' })).toBeNull();
  });

  it('a very long message is left to the model', () => {
    expect(classifyHelpIntent(`help ${'x '.repeat(300)}`)).toBeNull();
  });
});

// Review fix: "unauthorised" skips the model and opens a fraud case, so it must
// be a first-person claim. A denial ("it's not a scam"), a question ("is this
// a scam?") or a send request that mentions fraud reaches the model.
describe('classifyHelpIntent: a fraud claim is first person', () => {
  it.each([
    ['I was scammed', 'en'],
    ["I think I've been scammed", 'en'],
    ['my card was stolen', 'en'],
    ['my account got hacked', 'en'],
    ['someone used my account', 'en'],
    ["I didn't make this", 'en'],
    ['I did not authorize this transfer', 'en'],
    ['unauthorized transaction on my card', 'en'],
    ['I want to report fraud', 'en'],
    ["I'm a victim of fraud", 'en'],
    ['मेरा अकाउंट हैक हो गया', 'hi'],
    ['मेरे साथ धोखा हुआ', 'hi'],
    ['mere saath dhokha hua', 'hinglish'],
    ['mera account hack ho gaya', 'hinglish'],
    ['me estafaron', 'es'],
    ['mi cuenta fue hackeada', 'es'],
    ['yo no hice esta transferencia', 'es'],
  ])('%j → unauthorised (%s)', (text, lang) => {
    expect(classifyHelpIntent(text)).toEqual({ intent: 'unauthorised', lang });
  });

  it.each([
    "no it's not a scam, he is my brother",
    'not a scam, please continue',
    'no, this is not fraud',
    'nahi, ye scam nahi hai',
    'ye dhokha nahi hai',
    'यह धोखा नहीं है',
    'क्या यह धोखाधड़ी है?',
    'no es una estafa, es mi hermano',
    '¿es una estafa?',
    'Is this a scam?',
    'is it a scam',
    'is smartremit legit or a scam',
    'are you a scam?',
    'send $200 to my mom, her card was stolen',
    'please send 100 to dad, my old card was stolen so I use a new one',
    'my mom got scammed last year so I want to be careful',
    "I didn't send it yet",
    "I didn't make the payment yet, can you send the link again",
    'maine abhi tak nahi bheja',
    'how do I avoid scams',
    'scam',
  ])('%j → not unauthorised', (text) => {
    expect(classifyHelpIntent(text)?.intent).not.toBe('unauthorised');
  });
});

describe('the intent decides the case reason and whether the model still runs', () => {
  it('cancel records a case and lets the bot continue; every other intent answers with fixed text', () => {
    expect(helpIntentSkipsModel('cancel')).toBe(false);
    for (const i of ['help', 'human', 'complaint', 'money_problem', 'unauthorised'] as const) expect(helpIntentSkipsModel(i)).toBe(true);
  });

  it('maps each intent to a fixed case reason', () => {
    expect(helpCaseReasonFor('help')).toBe('question');
    expect(helpCaseReasonFor('human')).toBe('question');
    expect(helpCaseReasonFor('complaint')).toBe('complaint');
    expect(helpCaseReasonFor('money_problem')).toBe('payment_problem');
    expect(helpCaseReasonFor('unauthorised')).toBe('unauthorised');
    expect(helpCaseReasonFor('cancel')).toBe('cancel_request');
  });
});

describe('helpIntentReply: fixed text from hold-replies.ts, in the reply language, with the case number', () => {
  it('English on WhatsApp: the case number and where the answer arrives', () => {
    const r = helpIntentReply({ intent: 'help', lang: 'en' }, { caseId: 'tk_abc123', channel: 'whatsapp' });
    expect(r).toContain('tk_abc123');
    expect(r).toContain(HELP_CASE_REPLIES.en.where_whatsapp);
    expect(r.startsWith(HELP_CASE_REPLIES.en.case_opened.replace('{case}', 'tk_abc123'))).toBe(true);
  });

  it('Telegram and the web name their own place for the answer', () => {
    expect(helpIntentReply({ intent: 'human', lang: 'en' }, { caseId: 'tk_1', channel: 'telegram' })).toContain(HELP_CASE_REPLIES.en.where_telegram);
    expect(helpIntentReply({ intent: 'human', lang: 'en' }, { caseId: 'tk_1', channel: 'web' })).toContain(HELP_CASE_REPLIES.en.where_web);
  });

  it('Hindi and Hinglish get the Hinglish text (the bot answers Hindi in Roman letters); Spanish gets Spanish', () => {
    const hi = helpIntentReply({ intent: 'help', lang: 'hi' }, { caseId: 'tk_1', channel: 'whatsapp' });
    expect(hi).toBe(helpIntentReply({ intent: 'help', lang: 'hinglish' }, { caseId: 'tk_1', channel: 'whatsapp' }));
    expect(hi).not.toMatch(/[ऀ-ॿ]/);
    expect(hi).toContain(HELP_CASE_REPLIES.hinglish.where_whatsapp);
    expect(helpIntentReply({ intent: 'help', lang: 'es' }, { caseId: 'tk_1', channel: 'whatsapp' })).toContain(HELP_CASE_REPLIES.es.where_whatsapp);
  });

  it('a money problem and an unauthorised payment get their own opening line', () => {
    const money = helpIntentReply({ intent: 'money_problem', lang: 'en' }, { caseId: 'tk_1', channel: 'whatsapp' });
    const unauth = helpIntentReply({ intent: 'unauthorised', lang: 'en' }, { caseId: 'tk_1', channel: 'whatsapp' });
    expect(money.startsWith(HELP_CASE_REPLIES.en.case_money.replace('{case}', 'tk_1'))).toBe(true);
    expect(unauth.startsWith(HELP_CASE_REPLIES.en.case_unauthorised.replace('{case}', 'tk_1'))).toBe(true);
  });

  it('never promises a reply time or an in-chat answer', () => {
    for (const lang of ['en', 'hinglish', 'es'] as const) {
      for (const intent of ['help', 'money_problem', 'unauthorised'] as const) {
        const r = helpIntentReply({ intent, lang }, { caseId: 'tk_1', channel: 'whatsapp' }).toLowerCase();
        expect(r).not.toMatch(/\b(minute|hour|today|shortly|soon|24)\b/);
        expect(r).not.toContain('reply here in this chat');
        expect(r).not.toContain('teammate will reach out');
      }
    }
  });
});
