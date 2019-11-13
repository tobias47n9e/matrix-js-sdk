/*
Copyright 2019 New Vector Ltd

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

/**
 * Cross signing methods
 * @module crypto/CrossSigning
 */

import {pkSign, pkVerify} from './olmlib';
import {EventEmitter} from 'events';
import logger from '../logger';

function getPublicKey(keyInfo) {
    return Object.entries(keyInfo.keys)[0];
}

export class CrossSigningInfo extends EventEmitter {
    /**
     * Information about a user's cross-signing keys
     *
     * @class
     *
     * @param {string} userId the user that the information is about
     * @param {object} callbacks Callbacks used to interact with the app
     *     Requires getCrossSigningKey and saveCrossSigningKeys
     */
    constructor(userId, callbacks) {
        super();

        // you can't change the userId
        Object.defineProperty(this, 'userId', {
            enumerable: true,
            value: userId,
        });
        this._callbacks = callbacks || {};
        this.keys = {};
        this.firstUse = true;
    }

    /**
     * Calls the app callback to ask for a private key
     * @param {string} type The key type ("master", "self_signing", or "user_signing")
     * @param {Uint8Array} expectedPubkey The matching public key or undefined to use
     *     the stored public key for the given key type.
     */
    async getCrossSigningKey(type, expectedPubkey) {
        if (!this._callbacks.getCrossSigningKey) {
            throw new Error("No getCrossSigningKey callback supplied");
        }

        if (expectedPubkey === undefined) {
            expectedPubkey = getPublicKey(this.keys[type])[1];
        }

        const privkey = await this._callbacks.getCrossSigningKey(type, expectedPubkey);
        if (!privkey) {
            throw new Error(
                "getCrossSigningKey callback for  " + type + " returned falsey",
            );
        }
        const signing = new global.Olm.PkSigning();
        const gotPubkey = signing.init_with_seed(privkey);
        if (gotPubkey !== expectedPubkey) {
            signing.free();
            throw new Error(
                "Key type " + type + " from getCrossSigningKey callback did not match",
            );
        } else {
            return [gotPubkey, signing];
        }
    }

    static fromStorage(obj, userId) {
        const res = new CrossSigningInfo(userId);
        for (const prop in obj) {
            if (obj.hasOwnProperty(prop)) {
                res[prop] = obj[prop];
            }
        }
        return res;
    }

    toStorage() {
        return {
            keys: this.keys,
            firstUse: this.firstUse,
        };
    }

    /** Get the ID used to identify the user
     *
     * @param {string} type The type of key to get the ID of.  One of "master",
     * "self_signing", or "user_signing".  Defaults to "master".
     *
     * @return {string} the ID
     */
    getId(type) {
        type = type || "master";
        return this.keys[type] && getPublicKey(this.keys[type])[1];
    }

    async resetKeys(level) {
        if (!this._callbacks.saveCrossSigningKeys) {
            throw new Error("No saveCrossSigningKeys callback supplied");
        }

        if (level === undefined || level & 4 || !this.keys.master) {
            level = CrossSigningLevel.MASTER;
        } else if (level === 0) {
            return;
        }

        const privateKeys = {};
        const keys = {};
        let masterSigning;
        let masterPub;

        try {
            if (level & 4) {
                masterSigning = new global.Olm.PkSigning();
                privateKeys.master = masterSigning.generate_seed();
                masterPub = masterSigning.init_with_seed(privateKeys.master);
                keys.master = {
                    user_id: this.userId,
                    usage: ['master'],
                    keys: {
                        ['ed25519:' + masterPub]: masterPub,
                    },
                };
            } else {
                [masterPub, masterSigning] = await this.getCrossSigningyKey("master");
            }

            if (level & CrossSigningLevel.SELF_SIGNING) {
                const sskSigning = new global.Olm.PkSigning();
                try {
                    privateKeys.self_signing = sskSigning.generate_seed();
                    const sskPub = sskSigning.init_with_seed(privateKeys.self_signing);
                    keys.self_signing = {
                        user_id: this.userId,
                        usage: ['self_signing'],
                        keys: {
                            ['ed25519:' + sskPub]: sskPub,
                        },
                    };
                    pkSign(keys.self_signing, masterSigning, this.userId, masterPub);
                } finally {
                    sskSigning.free();
                }
            }

            if (level & CrossSigningLevel.USER_SIGNING) {
                const uskSigning = new global.Olm.PkSigning();
                try {
                    privateKeys.user_signing = uskSigning.generate_seed();
                    const uskPub = uskSigning.init_with_seed(privateKeys.user_signing);
                    keys.user_signing = {
                        user_id: this.userId,
                        usage: ['user_signing'],
                        keys: {
                            ['ed25519:' + uskPub]: uskPub,
                        },
                    };
                    pkSign(keys.user_signing, masterSigning, this.userId, masterPub);
                } finally {
                    uskSigning.free();
                }
            }

            Object.assign(this.keys, keys);
            this._callbacks.saveCrossSigningKeys(privateKeys);
        } finally {
            if (masterSigning) {
                masterSigning.free();
            }
        }
    }

    setKeys(keys) {
        const signingKeys = {};
        if (keys.master) {
            if (keys.master.user_id !== this.userId) {
                const error = "Mismatched user ID " + keys.master.user_id +
                      " in master key from " + this.userId;
                logger.error(error);
                throw new Error(error);
            }
            if (!this.keys.master) {
                // this is the first key we've seen, so first-use is true
                this.firstUse = true;
            } else if (getPublicKey(keys.master)[1] !== this.getId()) {
                // this is a different key, so first-use is false
                this.firstUse = false;
            } // otherwise, same key, so no change
            signingKeys.master = keys.master;
        } else if (this.keys.master) {
            signingKeys.master = this.keys.master;
        } else {
            throw new Error("Tried to set cross-signing keys without a master key");
        }
        const masterKey = getPublicKey(signingKeys.master)[1];

        // verify signatures
        if (keys.user_signing) {
            if (keys.user_signing.user_id !== this.userId) {
                const error = "Mismatched user ID " + keys.master.user_id +
                      " in user_signing key from " + this.userId;
                logger.error(error);
                throw new Error(error);
            }
            try {
                pkVerify(keys.user_signing, masterKey, this.userId);
            } catch (e) {
                logger.error("invalid signature on user-signing key");
                // FIXME: what do we want to do here?
                throw e;
            }
        }
        if (keys.self_signing) {
            if (keys.self_signing.user_id !== this.userId) {
                const error = "Mismatched user ID " + keys.master.user_id +
                      " in self_signing key from " + this.userId;
                logger.error(error);
                throw new Error(error);
            }
            try {
                pkVerify(keys.self_signing, masterKey, this.userId);
            } catch (e) {
                logger.error("invalid signature on self-signing key");
                // FIXME: what do we want to do here?
                throw e;
            }
        }

        // if everything checks out, then save the keys
        if (keys.master) {
            this.keys.master = keys.master;
            // if the master key is set, then the old self-signing and
            // user-signing keys are obsolete
            delete this.keys.self_signing;
            delete this.keys.user_signing;
        }
        if (keys.self_signing) {
            this.keys.self_signing = keys.self_signing;
        }
        if (keys.user_signing) {
            this.keys.user_signing = keys.user_signing;
        }
    }

    async signObject(data, type) {
        const [pubkey, signing] = await this.getCrossSigningKey(type);
        try {
            pkSign(data, signing, this.userId, pubkey);
            return data;
        } finally {
            signing.free();
        }
    }

    async signUser(key) {
        if (!this.keys.user_signing) {
            return;
        }
        return this.signObject(key.keys.master, "user_signing");
    }

    async signDevice(userId, device) {
        if (userId !== this.userId) {
            throw new Error(
                `Trying to sign ${userId}'s device; can only sign our own device`,
            );
        }
        if (!this.keys.self_signing) {
            return;
        }
        return this.signObject(
            {
                algorithms: device.algorithms,
                keys: device.keys,
                device_id: device.deviceId,
                user_id: userId,
            }, "self_signing",
        );
    }

    checkUserTrust(userCrossSigning) {
        // if we're checking our own key, then it's trusted if the master key
        // and self-signing key match
        if (this.userId === userCrossSigning.userId
            && this.getId() && this.getId() === userCrossSigning.getId()
            && this.getId("self_signing")
            && this.getId("self_signing") === userCrossSigning.getId("self_signing")) {
            return CrossSigningVerification.VERIFIED
                | (this.firstUse ? CrossSigningVerification.TOFU
                   : CrossSigningVerification.UNVERIFIED);
        }

        if (!this.keys.user_signing) {
            return (userCrossSigning.firstUse ? CrossSigningVerification.TOFU
                    : CrossSigningVerification.UNVERIFIED);
        }

        let userTrusted;
        const userMaster = userCrossSigning.keys.master;
        const uskId = getPublicKey(this.keys.user_signing)[1];
        try {
            pkVerify(userMaster, uskId, this.userId);
            userTrusted = true;
        } catch (e) {
            userTrusted = false;
        }
        return (userTrusted ? CrossSigningVerification.VERIFIED
                : CrossSigningVerification.UNVERIFIED)
             | (userCrossSigning.firstUse ? CrossSigningVerification.TOFU
                : CrossSigningVerification.UNVERIFIED);
    }

    checkDeviceTrust(userCrossSigning, device) {
        const userTrust = this.checkUserTrust(userCrossSigning);

        const userSSK = userCrossSigning.keys.self_signing;
        if (!userSSK) {
            return 0;
        }
        const deviceObj = deviceToObject(device, userCrossSigning.userId);
        try {
            pkVerify(userSSK, userCrossSigning.getId(), userCrossSigning.userId);
            pkVerify(deviceObj, getPublicKey(userSSK)[1], userCrossSigning.userId);
            return userTrust;
        } catch (e) {
            return 0;
        }
    }
}

function deviceToObject(device, userId) {
    return {
        algorithms: device.algorithms,
        keys: device.keys,
        device_id: device.deviceId,
        user_id: userId,
        signatures: device.signatures,
    };
}

export const CrossSigningLevel = {
    // NB. The actual master key is 4 but you must, by definition, reset all
    // keys if you reset the master key so this is essentially 'all keys'
    MASTER: 7,
    SELF_SIGNING: 1,
    USER_SIGNING: 2,
};

export const CrossSigningVerification = {
    UNVERIFIED: 0,
    TOFU: 1,
    VERIFIED: 2,
};