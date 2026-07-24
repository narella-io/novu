import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { AuthProviderEnum, normalizeEmail } from '@novu/shared';
import googlePassport from 'passport-google-oauth20';
import { Metadata, StateStoreStoreCallback } from 'passport-oauth2';
import { AuthService } from '../auth.service';

/**
 * narella: native Google OAuth for the self-hosted fork, mirroring the
 * upstream GitHubStrategy. Access is restricted to the comma-separated
 * allowlist in GOOGLE_OAUTH_ALLOWED_EMAILS — this dashboard is an internal
 * back-office tool, not a signup surface.
 */
@Injectable()
export class GoogleStrategy extends PassportStrategy(googlePassport.Strategy, 'google') {
  constructor(private authService: AuthService) {
    super({
      clientID: process.env.GOOGLE_OAUTH_CLIENT_ID,
      clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
      callbackURL: `${process.env.API_ROOT_URL}/v1/auth/google/callback`,
      scope: ['profile', 'email'],
      passReqToCallback: true,
      store: {
        verify(req, state: string, meta: Metadata, callback) {
          callback(null, true, JSON.stringify(req.query));
        },
        store(req, meta: Metadata, callback: StateStoreStoreCallback) {
          callback(null, JSON.stringify(req.query));
        },
      },
    });
  }

  async validate(req, accessToken: string, refreshToken: string, googleProfile, done: (err, data) => void) {
    try {
      const email = normalizeEmail(googleProfile.emails?.[0]?.value || '');
      const allowed = (process.env.GOOGLE_OAUTH_ALLOWED_EMAILS || '')
        .split(',')
        .map((entry) => normalizeEmail(entry.trim()))
        .filter(Boolean);

      if (!email || !allowed.includes(email)) {
        throw new UnauthorizedException(`Google account ${email || '(no email)'} is not allowlisted`);
      }

      const profile = {
        name: googleProfile.displayName || email,
        login: email,
        email,
        avatar_url: googleProfile.photos?.[0]?.value,
        id: googleProfile.id,
      };
      const parsedState = this.parseState(req);

      const response = await this.authService.authenticate(
        AuthProviderEnum.GOOGLE,
        accessToken,
        refreshToken,
        profile,
        parsedState?.distinctId,
        { origin: parsedState?.source, invitationToken: parsedState?.invitationToken }
      );

      done(null, {
        token: response.token,
        newUser: response.newUser,
      });
    } catch (err) {
      done(err, false);
    }
  }

  private parseState(req) {
    try {
      return JSON.parse(req.query.state);
    } catch (e) {
      return {};
    }
  }
}
