export function ownerChoiceRequestId(state: string, visitCount: number): string {
  return `owner-choice:${state}#${visitCount}`;
}
