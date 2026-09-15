import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { UsersService } from '../../users/users.service';

export interface JwtPayload {
  sub: string;
  email: string;
  sid?: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    private readonly configService: ConfigService,
    private readonly usersService: UsersService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey:
        configService.get<string>('JWT_ACCESS_SECRET')!,
    });
  }

  async validate(payload: JwtPayload) {
    const user =
      await this.usersService.findByIdWithAuthorization(
        payload.sub,
      );

    if (!user) {
      throw new UnauthorizedException();
    }

    const roles = user.userRoles.map(
      (userRole) => userRole.role.name,
    );

    const permissions = user.userRoles.flatMap(
      (userRole) =>
        userRole.role.rolePermissions.map(
          (rolePermission) =>
            `${rolePermission.permission.resource}:${rolePermission.permission.action}`,
        ),
    );

    return {
      id: user.id,
      email: user.email,
      roles: [...new Set(roles)],
      permissions: [...new Set(permissions)],
    };
  }
}