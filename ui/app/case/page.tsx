import { redirect } from 'next/navigation';
import { connection } from 'next/server';
import CaseDemo from './CaseDemo';

export default async function CasePage() {
  await connection();
  if (process.env.AIFIOS_ENABLE_DEMO_SURFACES !== '1') {
    redirect('/production?stage=1');
  }

  return <CaseDemo />;
}
