import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { RiLogoutBoxRLine } from 'react-icons/ri';
import { useNavigate } from 'react-router-dom';
import { Avatar, AvatarImage } from '@/components/primitives/avatar';
import { Button } from '@/components/primitives/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/primitives/dropdown-menu';
import { UserAvatar } from './icons';
import { useUser } from './index';

const JWT_STORAGE_KEY = 'self-hosted-jwt'; // As defined in components.tsx

export function UserButton() {
  const { user } = useUser() as {
    user:
      | { firstName?: string; lastName?: string; imageUrl?: string; emailAddresses?: { emailAddress: string }[] }
      | undefined;
  };
  const [isOpen, setIsOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  if (!user) return null;

  const userName = `${user.firstName} ${user.lastName}`;

  const handleLogout = () => {
    localStorage.removeItem(JWT_STORAGE_KEY);

    if (typeof window !== 'undefined') {
      (window as any).Clerk = { ...((window as any).Clerk || {}), loggedIn: false };
    }

    queryClient.clear();
    navigate('/auth/sign-in');
  };

  return (
    <div className="shrink-0">
      <DropdownMenu open={isOpen} onOpenChange={setIsOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            ref={buttonRef}
            variant="secondary"
            size="sm"
            className="h-6 w-6 rounded-full bg-white p-0 hover:bg-gray-50 focus:outline-hidden focus:ring-0 focus-visible:shadow-none"
          >
            <Avatar className="h-6 w-6 border border-gray-200">
              <AvatarImage src={user.imageUrl || `${window.location.origin}/images/avatar.svg`} alt={userName} />
            </Avatar>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-[300px] border border-gray-200 bg-white shadow-sm" sideOffset={5}>
          <div className="flex items-center gap-3 p-3">
            {user.imageUrl ? (
              <Avatar className="h-8 w-8 rounded-full">
                <AvatarImage src={user.imageUrl} alt={userName} />
              </Avatar>
            ) : (
              <UserAvatar className="rounded-full" />
            )}
            <span className="truncate text-sm font-medium text-gray-900">{userName}</span>
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="flex cursor-pointer items-center gap-2 text-gray-700 hover:bg-gray-50"
            onClick={handleLogout}
          >
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <RiLogoutBoxRLine className="h-3.5 w-3.5 shrink-0 text-gray-500" />
              <span>Logout</span>
            </div>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
