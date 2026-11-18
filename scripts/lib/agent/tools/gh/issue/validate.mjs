// Fixed-target, read-only Issue Audit candidate preflight. This is NOT a
// writer and does not authorize E2E selection changes or completed receipts.
import { auditIssue } from '../../../../../issue-contract.mjs';
import { VERIFICATION_TIERS, readVerificationTier } from '../../../../../verification-tier-policy.mjs';
import {
  candidateIssue, completeIssueUpdateProposal, enforceE2EReadOnly,
  isNoneOnlyMissingE2EReport, completeNoneOnlyE2EBody,
} from './update.mjs';

const FIELDS=new Set(['title','body','body_without_e2e','labels','comment',
  'verification_tier','tier_reason']);
const MAX_BODY=128*1024,MAX_COMMENT=8000;

export function validateIssueAuditCandidate(source, proposal) {
  const reject=(code,message)=>({ok:false,code,findings:[String(message).slice(0,2400)]});
  if (!source || !Number.isSafeInteger(source.number) || source.number<1 ||
      String(source.state).toUpperCase()!=='OPEN')
    return reject('ISSUE_AUDIT_TARGET','Fixed Issue must be an open, positive-ID native Issue');
  if (!proposal || typeof proposal!=='object'||Array.isArray(proposal)||
      Object.keys(proposal).some(key=>!FIELDS.has(key)))
    return reject('ISSUE_AUDIT_PROPOSAL_REJECTED','Unknown or non-object proposal fields');
  try {
    const hasRepair=['title','body','body_without_e2e','labels']
      .some(key=>proposal[key]!=null);
    if(proposal.body != null && proposal.body_without_e2e != null)
      return reject('ISSUE_AUDIT_PROPOSAL_REJECTED','body and body_without_e2e are mutually exclusive');
    if(proposal.body_without_e2e!=null && !isNoneOnlyMissingE2EReport(source.body))
      return reject('ISSUE_AUDIT_E2E_PROTECTED','body_without_e2e is allowed only for missing none-only E2E Report');
    if(proposal.body!=null && isNoneOnlyMissingE2EReport(source.body))
      return reject('ISSUE_AUDIT_E2E_PROTECTED','Use body_without_e2e for missing none-only Report');
    for(const key of ['title','body','body_without_e2e']){
      if(proposal[key]!=null && (typeof proposal[key]!=='string'||
          !proposal[key].trim()||Buffer.byteLength(proposal[key],'utf8')>MAX_BODY))
        return reject('ISSUE_AUDIT_FIELD_CONTRACT',key+' must be nonempty and at most 128 KiB');
    }
    if(proposal.comment!=null &&
        (typeof proposal.comment!=='string'||!proposal.comment.trim()||
         proposal.comment.length>MAX_COMMENT))
      return reject('ISSUE_AUDIT_COMMENT_PROPOSAL','Comment must be nonempty and at most 8000 characters');
    if(proposal.verification_tier!=null &&
        (!VERIFICATION_TIERS.includes(proposal.verification_tier)||
         typeof proposal.tier_reason!=='string'||
         proposal.tier_reason.trim().length<20||
         proposal.tier_reason.length>2000))
      return reject('ISSUE_AUDIT_TIER_PROPOSAL','Invalid tier/reason; explanation must be 20–2000 characters');
    if(proposal.verification_tier!=null){
      const currentTier=readVerificationTier(source);
      if(currentTier.explicit && VERIFICATION_TIERS.indexOf(proposal.verification_tier)<
          VERIFICATION_TIERS.indexOf(currentTier.tier))
        return reject('ISSUE_AUDIT_TIER_DOWNGRADE','Verification tier downgrade requires trusted approval');
    }
    if(hasRepair){
      // Match the actual write path; incomplete labels or malformed E2E
      // cannot be hidden by a seemingly valid body-only proposal.
      const body=proposal.body_without_e2e==null ? proposal.body :
        completeNoneOnlyE2EBody(source.body,proposal.body_without_e2e);
      const fields=completeIssueUpdateProposal(source,{...proposal,body});
      enforceE2EReadOnly(source.body,fields.body);
      const candidate=candidateIssue(source,fields.title,fields.body,fields.labels);
      const contract=auditIssue(candidate);
      if(!contract.ok)
        return {ok:false,code:'ISSUE_AUDIT_CONTRACT_REJECTED',
          findings:contract.errors.slice(0,16).map(s=>String(s).slice(0,500))};
    }else{
      const contract=auditIssue(source);
      if(!contract.ok)return {ok:false,code:'ISSUE_AUDIT_CONTRACT_REJECTED',
        findings:contract.errors.slice(0,16).map(s=>String(s).slice(0,500))};
    }
    if(!hasRepair && proposal.verification_tier==null &&
        proposal.comment==null && !readVerificationTier(source).explicit)
      return reject('ISSUE_AUDIT_TIER_PROPOSAL','Verification tier remains unset');
    return {ok:true,code:'VALID_CANDIDATE',findings:[],
      caveat:'Read-only candidate check only. Trusted writer re-reads GitHub before every mutation.'};
  }catch(error){
    // Deterministic guard rejection is a candidate finding, not tool success.
    return reject(error?.code??'ISSUE_AUDIT_CANDIDATE_INVALID',error?.message??'Invalid candidate');
  }
}
