import { ProductionWorkbench } from '@/components/production/ProductionWorkbench';
import { getProductionStage } from '@/components/production/production-model';

type PageProps = {
  searchParams: Promise<{ stage?: string | string[]; materialRequest?: string | string[]; draftRestore?: string | string[]; openDraft?: string | string[] }>;
};

export default async function ProductionPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const stage = Array.isArray(params.stage) ? params.stage[0] : params.stage;
  const materialRequest = Array.isArray(params.materialRequest) ? params.materialRequest[0] : params.materialRequest;
  const draftRestore = Array.isArray(params.draftRestore) ? params.draftRestore[0] : params.draftRestore;

  const openDraft = Array.isArray(params.openDraft) ? params.openDraft[0] : params.openDraft;
  const initialStage = getProductionStage(stage);
  return <ProductionWorkbench key={`${initialStage}:${materialRequest || ''}:${draftRestore || ''}:${openDraft || ''}`} initialStage={initialStage} initialMaterialRequestId={materialRequest} initialSavedDraftId={openDraft} initialSavedDraftStage={stage ? initialStage : undefined} />;
}
