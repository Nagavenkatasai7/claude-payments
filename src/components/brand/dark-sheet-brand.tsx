/**
 * The SmartRemit brand line on the dark, WhatsApp-styled sheets (pay page, B2B bill, seller
 * onboarding, inactive site). SmartRemit is the only customer-facing brand (owner decision,
 * 2026-10-04), so these sheets never show a partner's name, logo or colour. The mark is decorative
 * (the text beside it names the brand); a plain <img> keeps the sheets free of the image optimizer.
 */
export function DarkSheetBrand() {
  return (
    <div className="mb-1 flex items-center gap-2 text-xl leading-normal font-extrabold text-[#25d366]">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/brand/smartremit-mark.png" alt="" width={26} height={26} className="h-[26px] w-[26px] flex-none" />
      SmartRemit
    </div>
  );
}
