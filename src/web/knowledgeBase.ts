import { UnsupportedCapabilityError } from './externalHttp'
export const listKnowledgeDocuments = async () => []
export const isKnowledgeDocumentIndexed = async () => false
export const addKnowledgeDocument = async (): Promise<never> => { throw new UnsupportedCapabilityError('知识库索引') }
export const removeKnowledgeDocuments = async (): Promise<never> => { throw new UnsupportedCapabilityError('知识库索引') }
