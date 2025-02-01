import { User } from "../models/User";
import type { UserStore, WebAuthnUser } from "../../../dist/types";

export class MongoUserStore implements UserStore {
    async get(identifier: string, byID = false): Promise<WebAuthnUser | undefined> {
        try {
            const user = await User.findOne(
                byID ? { userID: identifier } : { username: identifier }
            )
                .lean()
                .exec();
            console.log("🔹 Fetched User Data:", user);
            return user as WebAuthnUser | undefined;
        } catch (error) {
            console.error(
                `Error fetching user (${byID ? "userID" : "username"}: ${identifier}):`,
                error
            );
            return undefined;
        }
    }

    async save(user: WebAuthnUser): Promise<void> {
        try {
            // Ensure the publicKey is stored as a Buffer.
            user.passkeys = user.passkeys.map((passkey) => ({
                ...passkey,
                publicKey: Buffer.isBuffer(passkey.publicKey)
                    ? passkey.publicKey
                    : Buffer.from(passkey.publicKey),
            }));

            await User.findOneAndUpdate(
                { userID: user.userID },
                user,
                { upsert: true, new: true, setDefaultsOnInsert: true }
            ).exec();
        } catch (error) {
            console.error(`Error saving user (${user.userID}):`, error);
        }
    }
}