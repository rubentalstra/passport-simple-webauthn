import { User } from "../models/User";
import type { UserStore, WebAuthnUser } from "passport-simple-webauthn2";

export class MongoUserStore implements UserStore {
    async get(identifier: string, byID = false): Promise<WebAuthnUser | undefined> {
        try {
            const user = await User.findOne(
                byID ? { userID: identifier } : { username: identifier }
            )
                .lean() // Return a plain JavaScript object instead of a Mongoose document
                .exec();
            return user as WebAuthnUser | undefined;
        } catch (error) {
            console.error(`Error fetching user (${byID ? "userID" : "username"}: ${identifier}):`, error);
            return undefined;
        }
    }

    async save(user: WebAuthnUser): Promise<void> {
        try {
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