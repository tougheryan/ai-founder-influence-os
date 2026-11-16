/** Compatibility exports for older local builds. Product passwords are retired. */
export async function demoUnlockRequired(): Promise<boolean> {
  return false;
}

export async function verifyDemoUnlockCode(_value: string): Promise<boolean> {
  // Do not read old password files or turn an access code into a saved grant.
  void _value;
  return false;
}
