import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import OrganizationCreate from '@/components/auth/create-organization';
import { PageMeta } from '@/components/page-meta';
import { IS_SELF_HOSTED_CE } from '@/config';

export const OrganizationListPage = () => {
  const navigate = useNavigate();

  useEffect(() => {
    if (IS_SELF_HOSTED_CE) {
      // narella: a CE session without an organization (stale token minted
      // before the api's auto-create-org patch) used to ping-pong between
      // '/' and this page forever. Self-heal: drop the token and
      // re-authenticate — the api creates/joins the org during OAuth login.
      localStorage.removeItem('self-hosted-jwt');
      window.location.replace('/auth/sign-in');
    }
  }, [navigate]);

  return (
    <>
      <PageMeta title="Select or create organization" />
      <OrganizationCreate />
    </>
  );
};
