// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

/// @notice Independent EIP-712 encoding of the agent consent (domain `VeriWork AgentRegistry` / `1`, type
///         `AgentConsent(address owner,bytes32 metadataHash,uint256 deadline)`), the same encoding the TypeScript
///         `agentConsentTypedData` helper signs. Tests sign this digest instead of asking the contract for it.
library AgentConsent {
    bytes32 internal constant TYPEHASH = keccak256("AgentConsent(address owner,bytes32 metadataHash,uint256 deadline)");
    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    function domainSeparator(address registry, uint256 chainId) internal pure returns (bytes32) {
        return
            keccak256(
                abi.encode(DOMAIN_TYPEHASH, keccak256("VeriWork AgentRegistry"), keccak256("1"), chainId, registry)
            );
    }

    function digest(address registry, uint256 chainId, address owner, bytes32 metadataHash, uint256 deadline)
        internal
        pure
        returns (bytes32)
    {
        bytes32 structHash = keccak256(abi.encode(TYPEHASH, owner, metadataHash, deadline));
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(registry, chainId), structHash));
    }
}
