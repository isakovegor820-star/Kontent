const LEGAL_RISK = /(закон|стать(?:я|и|ю|ёй)|кодекс|суд|иск|юрист|адвокат|банкротств|правов|юридическ|договор|лицензи|штраф)/iu;

export function requiresBriefConfirmation(input: {
  text: string;
  hasBlockers: boolean;
  externalAction?: boolean;
}): boolean {
  const text = input.text.trim();
  return input.hasBlockers
    || Boolean(input.externalAction)
    || LEGAL_RISK.test(text);
}
