import { Strategy as PassportStrategy } from "passport-strategy";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import type { Request } from "express";
import { v4 as uuidv4 } from "uuid";
import winston from "winston";
import {
  bufferToBase64URL,
  serializeAuthenticationOptions,
  serializeRegistrationOptions,
} from "./utils";
import type { UserStore, WebAuthnUser, ChallengeStore } from "./types";
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server/esm/types";

export { ChallengeStore, WebAuthnUser, UserStore };

export class WebAuthnStrategy extends PassportStrategy {
  name = "webauthn";
  private readonly rpID: string;
  private readonly rpName: string;
  private readonly userStore: UserStore;
  private readonly challengeStore: ChallengeStore;
  private readonly debug: boolean;
  private readonly logger: winston.Logger;

  constructor(options: {
    rpID: string;
    rpName: string;
    userStore: UserStore;
    challengeStore: ChallengeStore;
    debug?: boolean;
  }) {
    super();
    this.rpID = options.rpID;
    this.rpName = options.rpName;
    this.userStore = options.userStore;
    this.challengeStore = options.challengeStore;
    this.debug = options.debug ?? false;

    this.logger = winston.createLogger({
      level: this.debug ? "debug" : "info",
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(({ timestamp, level, message, ...meta }) => {
          const metaString = Object.keys(meta).length
            ? JSON.stringify(meta)
            : "";
          return `${timestamp} [WebAuthnStrategy] ${level}: ${message} ${metaString}`;
        }),
      ),
      transports: [new winston.transports.Console()],
    });

    this.logger.info("WebAuthnStrategy initialized", {
      rpID: this.rpID,
      rpName: this.rpName,
      debug: this.debug,
    });
    this.debugLog("Debug logging enabled");
  }

  private debugLog(message: string, ...optionalParams: any[]): void {
    if (this.debug) {
      this.logger.debug(message, ...optionalParams);
    }
  }

  private async getUser(
    identifier: string,
    byID = false,
  ): Promise<WebAuthnUser | undefined> {
    return this.userStore.get(identifier, byID);
  }

  async registerChallenge(
    req: Request,
    username: string,
  ): Promise<Record<string, unknown>> {
    this.debugLog(`registerChallenge called for username: ${username}`);

    if (!username) throw new Error("Username required");

    let user = await this.getUser(username);
    if (!user) {
      this.debugLog(
        `User not found. Creating new user for username: ${username}`,
      );
      user = { userID: uuidv4(), username, passkeys: [] };
      await this.userStore.save(user);
      this.debugLog(`New user created with userID: ${user.userID}`);
    } else {
      this.debugLog(`User found with userID: ${user.userID}`);
    }

    this.debugLog("Generating registration options");
    const options = await generateRegistrationOptions({
      rpName: this.rpName || "WebAuthn Demo",
      rpID: this.rpID || "localhost",
      userID: Buffer.from(user.userID, "utf-8"),
      userName: user.username,
      attestationType: "none",
      excludeCredentials: user.passkeys.map((cred) => ({
        id: cred.id,
        type: "public-key",
        transports: cred.transports || ["internal", "usb", "ble", "nfc"],
      })),
      authenticatorSelection: {
        userVerification: "required",
        residentKey: "required",
        authenticatorAttachment: "platform",
      },
    });
    this.debugLog("Registration options generated", {
      challenge: bufferToBase64URL(options.challenge),
      options,
    });

    // Save the challenge (as a base64url string)
    const challengeStr = bufferToBase64URL(options.challenge);
    await this.challengeStore.save(user.userID, challengeStr);
    this.debugLog(`Challenge saved for userID ${user.userID}: ${challengeStr}`);

    const serializedOptions = serializeRegistrationOptions(options);
    this.debugLog("Serialized registration options", serializedOptions);

    this.logger.info(
      `Registration challenge generated for user ${user.username} (ID: ${user.userID})`,
    );

    return serializedOptions;
  }

  async registerCallback(
    req: Request,
    username: string,
    credential: RegistrationResponseJSON,
  ): Promise<WebAuthnUser> {
    this.debugLog(`registerCallback called for username: ${username}`);
    const user = await this.getUser(username);
    if (!user) {
      this.logger.error(`User not found for username: ${username}`);
      throw new Error("User not found");
    }
    this.debugLog(`User found with userID: ${user.userID}`);

    const challenge = await this.challengeStore.get(user.userID);
    if (!challenge) {
      this.logger.error(`Challenge not found for userID: ${user.userID}`);
      throw new Error("Challenge not found");
    }
    this.debugLog(
      `Challenge retrieved for userID ${user.userID}: ${challenge}`,
    );

    try {
      this.debugLog("Verifying registration response", credential);
      const verification = await verifyRegistrationResponse({
        response: credential,
        expectedChallenge: challenge,
        expectedOrigin:
          process.env.NODE_ENV === "development"
            ? `http://${this.rpID}`
            : `https://${this.rpID}`,
        expectedRPID: this.rpID || "localhost",
        requireUserVerification: true,
      });
      this.debugLog("Registration response verification result", verification);

      await this.challengeStore.delete(user.userID);
      this.debugLog(`Challenge deleted for userID ${user.userID}`);

      if (!verification.verified || !verification.registrationInfo) {
        this.logger.error("Registration verification failed");
        throw new Error("Verification failed");
      }

      const { publicKey, id, counter, transports } =
        verification.registrationInfo.credential;
      this.debugLog("Storing new passkey", { id, counter, transports });

      // Convert the returned publicKey into a Buffer.
      const publicKeyBuffer = Buffer.from(
        typeof publicKey === "object" ? Object.values(publicKey) : publicKey,
      );

      user.passkeys.push({
        id: id,
        publicKey: publicKeyBuffer,
        counter,
        transports,
      });

      await this.userStore.save(user);
      this.debugLog(
        `User updated and saved with new passkey, userID: ${user.userID}`,
      );
      this.logger.info(
        `User ${user.username} (ID: ${user.userID}) successfully registered.`,
      );
      return user;
    } catch (error) {
      const errorMsg =
        error instanceof Error ? error.message : "Registration failed";
      this.logger.error(`Error during registration callback: ${errorMsg}`);
      this.debugLog(`Error during registration callback: ${errorMsg}`);
      throw new Error(errorMsg);
    }
  }

  async loginChallenge(
    req: Request,
    username: string,
  ): Promise<Record<string, unknown>> {
    this.debugLog(`loginChallenge called for username: ${username}`);
    const user = await this.getUser(username);
    if (!user) {
      this.logger.error(`User not found for username: ${username}`);
      throw new Error("User not found");
    }
    this.debugLog(`User found with userID: ${user.userID}`);

    // Filter for platform authenticators.
    const platformCredentials = user.passkeys.filter((cred) =>
      cred.transports?.includes("internal"),
    );
    this.debugLog("Filtered platform credentials", platformCredentials);

    this.debugLog("Generating authentication options");
    const options = await generateAuthenticationOptions({
      rpID: this.rpID || "localhost",
      userVerification: "required",
      allowCredentials:
        platformCredentials.length > 0
          ? platformCredentials.map((cred) => ({
              id: cred.id, // stored id is already base64url encoded
              type: "public-key",
              transports: cred.transports,
            }))
          : undefined,
    });
    this.debugLog("Authentication options generated", {
      challenge: bufferToBase64URL(options.challenge),
      options,
    });

    const challengeStr = bufferToBase64URL(options.challenge);
    await this.challengeStore.save(user.userID, challengeStr);
    this.debugLog(`Challenge saved for userID ${user.userID}: ${challengeStr}`);

    const serializedOptions = serializeAuthenticationOptions(options);
    this.debugLog("Serialized authentication options", serializedOptions);

    this.logger.info(
      `Login challenge generated for user ${user.username} (ID: ${user.userID})`,
    );
    return serializedOptions;
  }

  async loginCallback(
    req: Request,
    username: string,
    credential: AuthenticationResponseJSON,
  ): Promise<WebAuthnUser> {
    this.debugLog(`loginCallback called for username: ${username}`);
    const user = await this.getUser(username);
    if (!user) {
      this.logger.error(`User not found for username: ${username}`);
      throw new Error("User not found");
    }
    this.debugLog(`User found with userID: ${user.userID}`);

    const challenge = await this.challengeStore.get(user.userID);
    if (!challenge) {
      this.logger.error(`Challenge not found for userID: ${user.userID}`);
      throw new Error("Challenge not found");
    }
    this.debugLog(
      `Challenge retrieved for userID ${user.userID}: ${challenge}`,
    );

    // Look up the passkey by its id.
    const passkey = user.passkeys.find((p) => p.id === credential.id);
    if (!passkey) {
      const errMsg = `Passkey not found for credential id: ${credential.id}`;
      this.logger.error(errMsg);
      this.debugLog(errMsg);
      throw new Error("Passkey not found");
    }
    this.debugLog("Passkey found", passkey);

    try {
      // Normalize the stored public key in case it is a BSON Binary
      const storedPublicKey =
        passkey.publicKey && (passkey.publicKey as any).buffer
          ? Buffer.from((passkey.publicKey as any).buffer)
          : Buffer.from(passkey.publicKey);

      this.debugLog("Verifying authentication response", credential);
      const verification = await verifyAuthenticationResponse({
        response: credential,
        expectedChallenge: challenge,
        expectedOrigin:
          process.env.NODE_ENV === "development"
            ? `http://${this.rpID}`
            : `https://${this.rpID}`,
        expectedRPID: this.rpID,
        credential: {
          id: passkey.id,
          publicKey: storedPublicKey,
          counter: passkey.counter,
          transports: passkey.transports,
        },
        requireUserVerification: true,
      });
      this.debugLog(
        "Authentication response verification result",
        verification,
      );

      await this.challengeStore.delete(user.userID);
      this.debugLog(`Challenge deleted for userID ${user.userID}`);

      if (!verification.verified) {
        this.logger.error("Authentication verification failed");
        this.debugLog("Authentication verification failed");
        throw new Error("Verification failed");
      }

      // Update the passkey counter.
      passkey.counter = verification.authenticationInfo.newCounter;
      await this.userStore.save(user);
      this.debugLog(
        `User updated and saved with updated passkey counter, userID: ${user.userID}`,
      );
      this.logger.info(
        `User ${user.username} (ID: ${user.userID}) successfully logged in.`,
      );
      return user;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Login failed";
      this.logger.error(`Error during login callback: ${errorMsg}`);
      this.debugLog(`Error during login callback: ${errorMsg}`);
      throw new Error(errorMsg);
    }
  }

  authenticate(_req: Request): void {
    throw new Error(
      "Use registerChallenge, registerCallback, loginChallenge, or loginCallback instead.",
    );
  }
}
