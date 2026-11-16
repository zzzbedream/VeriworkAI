// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Test} from "forge-std/Test.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";

/// @notice EIP-2612 signing helper (works for the mock and for the real G$, whose domain has no EIP-5267 getter).
abstract contract PermitSigner is Test {
    bytes32 internal constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
    bytes32 internal constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    struct PermitSig {
        uint256 deadline;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    function _signPermit(address token, uint256 ownerKey, address spender, uint256 value, uint256 deadline)
        internal
        view
        returns (PermitSig memory sig)
    {
        address owner = vm.addr(ownerKey);
        uint256 nonce = IERC20Permit(token).nonces(owner);
        bytes32 structHash = keccak256(abi.encode(PERMIT_TYPEHASH, owner, spender, value, nonce, deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", IERC20Permit(token).DOMAIN_SEPARATOR(), structHash));
        (sig.v, sig.r, sig.s) = vm.sign(ownerKey, digest);
        sig.deadline = deadline;
    }

    /// @dev Domain separator of G$: name "GoodDollar", version "1".
    function _goodDollarDomainSeparator(address token, uint256 chainId) internal pure returns (bytes32) {
        return keccak256(abi.encode(EIP712_DOMAIN_TYPEHASH, keccak256("GoodDollar"), keccak256("1"), chainId, token));
    }
}
