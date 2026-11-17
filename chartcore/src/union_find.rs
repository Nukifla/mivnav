// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! A single, minimal disjoint-set (union-find) implementation, shared by
//! every module in this crate that needs one — `derive::aid_group`
//! (grouping multi-part aid-to-navigation features) and
//! `mivnav::topology` (per-band navigable connected components) each
//! used to carry an independent copy of the identical algorithm; a
//! second, independently-tuned implementation is exactly the kind of
//! quiet divergence this crate's own conventions warn against (see
//! `routing::artifact::search`'s module docs on the shared `Supercover`
//! walk for the same argument, applied there to a DDA rather than a
//! disjoint set).
//!
//! Path halving plus deterministic min-root union: the SMALLER index
//! always becomes a group's root, so which root a group ends up under is
//! reproducible from the union CALLS alone, not from a hash or an
//! incidental `rank` counter's own history. Callers that already
//! renumber canonically downstream (`mivnav::topology`) do not depend on
//! this determinism, but it costs nothing to keep and removes one more
//! thing a future caller has to think about.

/// `u32` parents: half the memory of `usize` on the national-scale
/// `mivnav::topology` labelling (~10⁹ cells), the one caller where that
/// matters. Element counts must fit `u32` (`new` asserts it).
pub(crate) struct UnionFind {
    parent: Vec<u32>,
}

impl UnionFind {
    pub(crate) fn new(n: usize) -> UnionFind {
        assert!(
            n <= u32::MAX as usize,
            "UnionFind: {n} elements do not fit u32"
        );
        UnionFind {
            parent: (0..n as u32).collect(),
        }
    }

    /// The raw `parent` column, for a caller that unions a set of
    /// DISJOINT index ranges in parallel and then hands the merged result
    /// straight back to [`find`](Self::find) / [`union`](Self::union).
    ///
    /// A fresh [`new`](Self::new) leaves every entry self-referential
    /// (`parent[i] == i`); a worker that only ever links indices inside
    /// its own range keeps the "a group's root is its smallest member"
    /// invariant this type's `union` maintains, so the ranges recombine
    /// with no fix-up. Linking across the `&mut [u32]` slices handed
    /// out here would break that invariant — the caller is responsible
    /// for the disjointness.
    pub(crate) fn parent_mut(&mut self) -> &mut [u32] {
        &mut self.parent
    }

    /// Give up the `parent` column, e.g. to relabel it in place. Every
    /// entry satisfies `parent[i] <= i` (min-root union plus path halving
    /// only ever move a pointer to a smaller index).
    pub(crate) fn into_parent(self) -> Vec<u32> {
        self.parent
    }

    pub(crate) fn find(&mut self, x: usize) -> usize {
        let mut x = x as u32;
        while self.parent[x as usize] != x {
            self.parent[x as usize] = self.parent[self.parent[x as usize] as usize]; // path halving
            x = self.parent[x as usize];
        }
        x as usize
    }

    pub(crate) fn union(&mut self, a: usize, b: usize) {
        let (ra, rb) = (self.find(a), self.find(b));
        if ra != rb {
            // Deterministic: the larger root always attaches under the
            // smaller, so the final root of any group is its own
            // smallest member, independent of union order.
            self.parent[ra.max(rb)] = ra.min(rb) as u32;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn union_joins_and_find_agrees() {
        let mut uf = UnionFind::new(5);
        uf.union(0, 1);
        uf.union(1, 2);
        assert_eq!(uf.find(0), uf.find(2));
        assert_ne!(uf.find(0), uf.find(3));
    }

    #[test]
    fn min_root_wins_regardless_of_union_order() {
        let mut uf = UnionFind::new(4);
        uf.union(3, 1);
        uf.union(1, 2);
        assert_eq!(uf.find(3), 1);
        assert_eq!(uf.find(2), 1);

        let mut reordered = UnionFind::new(4);
        reordered.union(1, 2);
        reordered.union(3, 1);
        assert_eq!(reordered.find(3), 1);
        assert_eq!(reordered.find(2), 1);
    }

    #[test]
    fn singletons_are_their_own_root() {
        let mut uf = UnionFind::new(3);
        assert_eq!(uf.find(0), 0);
        assert_eq!(uf.find(1), 1);
        assert_eq!(uf.find(2), 2);
    }

    #[test]
    fn a_repeated_union_is_a_no_op() {
        let mut uf = UnionFind::new(2);
        uf.union(0, 1);
        uf.union(0, 1);
        uf.union(1, 0);
        assert_eq!(uf.find(0), uf.find(1));
    }
}
